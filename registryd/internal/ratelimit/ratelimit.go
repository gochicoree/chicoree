// Package ratelimit implements the pull rate limit: a per-client counter
// over a fixed window, configured from the admin panel (instance_settings
// row "ratelimit") with environment variables as the fallback. Counters live
// in Postgres, so every replica draws from the same budget; a Manager built
// without a Counter falls back to per-process counters.
package ratelimit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limit is "<count> requests per <window>"; a zero Limit means unlimited.
type Limit struct {
	Count  int64
	Window time.Duration
}

// IsZero reports whether the limit is disabled.
func (l Limit) IsZero() bool { return l.Count <= 0 || l.Window <= 0 }

// String renders the limit in the configuration syntax ("100/6h").
func (l Limit) String() string {
	if l.IsZero() {
		return ""
	}
	return fmt.Sprintf("%d/%s", l.Count, FormatWindow(l.Window))
}

var limitRe = regexp.MustCompile(`^\s*(\d+)\s*/\s*(\d+)\s*([smhd])\s*$`)

// ParseLimit parses "<count>/<window>", where the window is a number with a
// unit of s, m, h or d ("100/6h", "3/1m"). An empty string is unlimited.
// The same grammar is implemented in the web app (lib/rate-limit-shared.ts).
func ParseLimit(s string) (Limit, error) {
	if strings.TrimSpace(s) == "" {
		return Limit{}, nil
	}
	m := limitRe.FindStringSubmatch(s)
	if m == nil {
		return Limit{}, fmt.Errorf("invalid rate limit %q: expected <count>/<window>, e.g. 100/6h", s)
	}
	count, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || count <= 0 {
		return Limit{}, fmt.Errorf("invalid rate limit %q: count must be a positive integer", s)
	}
	n, _ := strconv.ParseInt(m[2], 10, 64)
	if n <= 0 {
		return Limit{}, fmt.Errorf("invalid rate limit %q: window must be positive", s)
	}
	var unit time.Duration
	switch m[3] {
	case "s":
		unit = time.Second
	case "m":
		unit = time.Minute
	case "h":
		unit = time.Hour
	case "d":
		unit = 24 * time.Hour
	}
	return Limit{Count: count, Window: time.Duration(n) * unit}, nil
}

// FormatWindow renders a duration in the configuration syntax.
func FormatWindow(d time.Duration) string {
	switch {
	case d%(24*time.Hour) == 0:
		return fmt.Sprintf("%dd", int64(d/(24*time.Hour)))
	case d%time.Hour == 0:
		return fmt.Sprintf("%dh", int64(d/time.Hour))
	case d%time.Minute == 0:
		return fmt.Sprintf("%dm", int64(d/time.Minute))
	default:
		return fmt.Sprintf("%ds", int64(d/time.Second))
	}
}

// ParseCIDRs parses a comma-, whitespace- or newline-separated list of
// networks or single addresses.
func ParseCIDRs(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' || r == '\r' }) {
		if p, err := netip.ParsePrefix(f); err == nil {
			out = append(out, p.Masked())
			continue
		}
		if a, err := netip.ParseAddr(f); err == nil {
			out = append(out, netip.PrefixFrom(a, a.BitLen()))
			continue
		}
		return nil, fmt.Errorf("invalid trusted proxy %q: expected a CIDR or IP address", f)
	}
	return out, nil
}

// Config is the effective rate-limit configuration.
type Config struct {
	Anonymous      Limit
	Authenticated  Limit
	TrustedProxies []netip.Prefix
}

// Enabled reports whether any limit applies.
func (c Config) Enabled() bool { return !c.Anonymous.IsZero() || !c.Authenticated.IsZero() }

func (c Config) equal(o Config) bool {
	if c.Anonymous != o.Anonymous || c.Authenticated != o.Authenticated || len(c.TrustedProxies) != len(o.TrustedProxies) {
		return false
	}
	for i := range c.TrustedProxies {
		if c.TrustedProxies[i] != o.TrustedProxies[i] {
			return false
		}
	}
	return true
}

// Settings is the JSON shape of the instance_settings "ratelimit" row, as
// written by the web app. Every field is optional; missing ones fall back to
// the environment.
type Settings struct {
	Anonymous      string `json:"anonymous"`
	Authenticated  string `json:"authenticated"`
	TrustedProxies string `json:"trustedProxies"`
}

// ConfigFromSettings merges the stored row over the environment defaults.
// A nil row means "no row": the defaults apply as they are.
func ConfigFromSettings(raw []byte, defaults Settings) (Config, error) {
	eff := defaults
	if raw != nil {
		var stored map[string]json.RawMessage
		if err := json.Unmarshal(raw, &stored); err != nil {
			return Config{}, fmt.Errorf("ratelimit settings: %w", err)
		}
		pick := func(field string, dst *string) {
			if v, ok := stored[field]; ok {
				var s string
				if json.Unmarshal(v, &s) == nil {
					*dst = s
				}
			}
		}
		pick("anonymous", &eff.Anonymous)
		pick("authenticated", &eff.Authenticated)
		pick("trustedProxies", &eff.TrustedProxies)
	}
	var cfg Config
	var err error
	if cfg.Anonymous, err = ParseLimit(eff.Anonymous); err != nil {
		return Config{}, err
	}
	if cfg.Authenticated, err = ParseLimit(eff.Authenticated); err != nil {
		return Config{}, err
	}
	if cfg.TrustedProxies, err = ParseCIDRs(eff.TrustedProxies); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Decision is the outcome of one Take.
type Decision struct {
	Allowed   bool
	Limit     Limit
	Remaining int64
	Reset     time.Time // when the caller's window starts over
}

// ResetIn is the number of whole seconds (rounded up) until the window resets.
func (d Decision) ResetIn(now time.Time) int64 {
	secs := int64(math.Ceil(d.Reset.Sub(now).Seconds()))
	if secs < 0 {
		secs = 0
	}
	return secs
}

// RetryAfter is ResetIn, but never less than one second (Retry-After: 0 is
// an invitation to hammer the server).
func (d Decision) RetryAfter(now time.Time) int64 {
	return max(1, d.ResetIn(now))
}

type entry struct {
	start time.Time
	count int64
}

// Limiter counts requests per key over a fixed window that starts with the
// key's first request and restarts once it has elapsed.
type Limiter struct {
	limit     Limit
	mu        sync.Mutex
	entries   map[string]*entry
	lastSweep time.Time
}

// NewLimiter returns a limiter for the given (non-zero) limit.
func NewLimiter(limit Limit) *Limiter {
	return &Limiter{limit: limit, entries: map[string]*entry{}}
}

// Take consumes one request for key at time now.
func (l *Limiter) Take(key string, now time.Time) Decision {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= l.limit.Window {
		l.sweep(now)
	}
	e := l.entries[key]
	if e == nil || now.Sub(e.start) >= l.limit.Window {
		e = &entry{start: now}
		l.entries[key] = e
	}
	allowed := e.count < l.limit.Count
	if allowed {
		e.count++
	}
	return Decision{
		Allowed:   allowed,
		Limit:     l.limit,
		Remaining: max(0, l.limit.Count-e.count),
		Reset:     e.start.Add(l.limit.Window),
	}
}

func (l *Limiter) sweep(now time.Time) {
	for k, e := range l.entries {
		if now.Sub(e.start) >= l.limit.Window {
			delete(l.entries, k)
		}
	}
	l.lastSweep = now
}

// Counter is the shared tally behind the limit: one row per key and window
// in Postgres (internal/store). Take adds one request to the window that
// starts at windowStart and reports the resulting count, so several replicas
// enforce one budget.
type Counter interface {
	TakeRateLimit(ctx context.Context, key string, windowStart time.Time) (int64, error)
}

// shared counts through a Counter. Windows are aligned to the wall clock
// (a 1h limit resets on the hour) so every replica agrees on the boundary
// without coordinating; the in-memory Limiter instead starts a window with
// the key's first request.
type shared struct {
	limit   Limit
	counter Counter
}

func (s *shared) take(ctx context.Context, key string, now time.Time) (Decision, error) {
	start := now.Truncate(s.limit.Window)
	count, err := s.counter.TakeRateLimit(ctx, key, start)
	if err != nil {
		return Decision{}, err
	}
	return Decision{
		Allowed:   count <= s.limit.Count,
		Limit:     s.limit,
		Remaining: max(0, s.limit.Count-count),
		Reset:     start.Add(s.limit.Window),
	}, nil
}

// Manager holds the live configuration and one limiter per client class.
type Manager struct {
	mu      sync.RWMutex
	cfg     Config
	counter Counter
	anon    *Limiter
	auth    *Limiter
	sanon   *shared
	sauth   *shared
}

// NewManager starts with cfg applied and counts in this process only.
func NewManager(cfg Config) *Manager {
	m := &Manager{}
	m.apply(cfg)
	return m
}

// NewSharedManager counts through the given Counter, so every replica draws
// from one budget.
func NewSharedManager(cfg Config, counter Counter) *Manager {
	m := &Manager{counter: counter}
	m.apply(cfg)
	return m
}

func (m *Manager) apply(cfg Config) {
	m.cfg = cfg
	m.anon, m.auth, m.sanon, m.sauth = nil, nil, nil, nil
	if !cfg.Anonymous.IsZero() {
		if m.counter != nil {
			m.sanon = &shared{limit: cfg.Anonymous, counter: m.counter}
		} else {
			m.anon = NewLimiter(cfg.Anonymous)
		}
	}
	if !cfg.Authenticated.IsZero() {
		if m.counter != nil {
			m.sauth = &shared{limit: cfg.Authenticated, counter: m.counter}
		} else {
			m.auth = NewLimiter(cfg.Authenticated)
		}
	}
}

// Shared reports whether counters live in Postgres rather than this process.
func (m *Manager) Shared() bool { return m.counter != nil }

// Reload swaps the configuration when it changed; counters restart on a
// change (limits are edited rarely, and a fresh window is the least
// surprising outcome for the administrator watching the effect).
func (m *Manager) Reload(cfg Config) (changed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg.equal(cfg) {
		return false
	}
	m.apply(cfg)
	return true
}

// Config returns the configuration in force.
func (m *Manager) Config() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg
}

// ErrUnlimited is returned by Take when no limit applies to the client class.
var ErrUnlimited = errors.New("no rate limit configured")

// Take charges one request to the anonymous (per IP) or authenticated (per
// subject) budget. Shared counters share one table, so the class is part of
// the key.
func (m *Manager) Take(ctx context.Context, anonymous bool, key string, now time.Time) (Decision, error) {
	m.mu.RLock()
	l, sh := m.auth, m.sauth
	if anonymous {
		l, sh = m.anon, m.sanon
	}
	m.mu.RUnlock()
	switch {
	case sh != nil:
		class := "auth"
		if anonymous {
			class = "anon"
		}
		return sh.take(ctx, class+"|"+key, now)
	case l != nil:
		return l.Take(key, now), nil
	default:
		return Decision{}, ErrUnlimited
	}
}

// ClientIP picks the address a request should be accounted to: the last
// X-Forwarded-For hop when the direct peer is a trusted proxy, otherwise the
// peer itself. Falls back to the raw remote address string if it does not
// parse (never an empty key).
func ClientIP(remoteAddr, forwardedFor string, trusted []netip.Prefix) string {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	peer, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return remoteAddr
	}
	peer = peer.Unmap()
	if forwardedFor != "" && contains(trusted, peer) {
		hops := strings.Split(forwardedFor, ",")
		if last, err := netip.ParseAddr(strings.TrimSpace(hops[len(hops)-1])); err == nil {
			return last.Unmap().String()
		}
	}
	return peer.String()
}

func contains(prefixes []netip.Prefix, a netip.Addr) bool {
	for _, p := range prefixes {
		if p.Addr().Is4() != a.Is4() {
			continue
		}
		if p.Contains(a) {
			return true
		}
	}
	return false
}
