package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"registryd/internal/auth"
	"registryd/internal/ratelimit"
	"registryd/internal/store"
)

// EnableRateLimiting loads the effective limits and turns enforcement on.
// Pair it with RunRateLimitReload so admin-panel changes are picked up.
func (s *Server) EnableRateLimiting(ctx context.Context) error {
	cfg, err := s.loadRateLimitConfig(ctx)
	if err != nil {
		return err
	}
	s.limiter = ratelimit.NewManager(cfg)
	slog.Info("ratelimit: pull limits", "anonymous", orUnlimited(cfg.Anonymous.String()),
		"authenticated", orUnlimited(cfg.Authenticated.String()), "trustedProxies", len(cfg.TrustedProxies))
	return nil
}

// pullLimitExempt reports whether an identity is never rate limited:
// instance administrators (tokens carrying the registry:catalog grant),
// the web app's own service reads, and mirror / proxy subjects.
func pullLimitExempt(id *auth.Identity) bool {
	if id == nil {
		return false
	}
	if id.Can("registry", "catalog", "*") {
		return true
	}
	switch {
	case id.Subject == "user:system",
		strings.HasPrefix(id.Subject, "mirror:"),
		strings.HasPrefix(id.Subject, "proxy:"):
		return true
	}
	return false
}

// rateLimitKey picks the budget a request draws from: the client IP for
// anonymous requests, the token subject otherwise.
func rateLimitKey(r *http.Request, id *auth.Identity, cfg ratelimit.Config) (anonymous bool, key string) {
	if id.ActorType() == "anonymous" {
		return true, "ip:" + ratelimit.ClientIP(r.RemoteAddr, r.Header.Get("X-Forwarded-For"), cfg.TrustedProxies)
	}
	return false, id.Subject
}

// Rate-limit header names in the casing of the IETF RateLimit header draft.
// They are written straight into the header map: Header.Set would
// canonicalise them to "Ratelimit-Limit" (harmless for clients, which
// compare case-insensitively, but not what people grep for).
const (
	headerRateLimitLimit     = "RateLimit-Limit"
	headerRateLimitPolicy    = "RateLimit-Policy"
	headerRateLimitRemaining = "RateLimit-Remaining"
	headerRateLimitReset     = "RateLimit-Reset"
)

// setRateLimitHeaders advertises the budget on every limited response.
func setRateLimitHeaders(h http.Header, d ratelimit.Decision, now time.Time) {
	h[headerRateLimitLimit] = []string{strconv.FormatInt(d.Limit.Count, 10)}
	h[headerRateLimitPolicy] = []string{fmt.Sprintf("%d;w=%d", d.Limit.Count, int64(d.Limit.Window/time.Second))}
	h[headerRateLimitRemaining] = []string{strconv.FormatInt(d.Remaining, 10)}
	h[headerRateLimitReset] = []string{strconv.FormatInt(d.ResetIn(now), 10)}
}

// rateLimitHeader reads one of the headers above (exact key, see setRateLimitHeaders).
func rateLimitHeader(h http.Header, key string) string {
	if v := h[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// enforcePullLimit charges a manifest request to the caller's pull budget.
// It returns false after writing a 429 when the budget is exhausted.
func (s *Server) enforcePullLimit(w http.ResponseWriter, r *http.Request, rc *reqCtx) bool {
	if s.limiter == nil || pullLimitExempt(rc.identity) {
		return true
	}
	anonymous, key := rateLimitKey(r, rc.identity, s.limiter.Config())
	now := time.Now()
	d, err := s.limiter.Take(anonymous, key, now)
	if errors.Is(err, ratelimit.ErrUnlimited) {
		return true
	}
	setRateLimitHeaders(w.Header(), d, now)
	if d.Allowed {
		return true
	}
	s.metrics.RateLimited(anonymous)
	retry := d.RetryAfter(now)
	w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
	msg := fmt.Sprintf("pull rate limit exceeded: %d pulls per %s", d.Limit.Count, ratelimit.FormatWindow(d.Limit.Window))
	if anonymous {
		msg += " for anonymous clients; sign in for a separate budget"
	} else {
		msg += " for this account"
	}
	msg += fmt.Sprintf("; retry in %ds", retry)
	writeError(w, http.StatusTooManyRequests, CodeTooManyRequests, msg)
	return false
}

// loadRateLimitConfig resolves the effective configuration: the admin
// panel's instance_settings row when present, else the environment.
func (s *Server) loadRateLimitConfig(ctx context.Context) (ratelimit.Config, error) {
	defaults := ratelimit.Settings{
		Anonymous:      s.cfg.RateLimitAnonymous,
		Authenticated:  s.cfg.RateLimitAuthenticated,
		TrustedProxies: s.cfg.RateLimitTrustedProxies,
	}
	raw, err := s.store.InstanceSetting(ctx, "ratelimit")
	if errors.Is(err, store.ErrNotFound) {
		return ratelimit.ConfigFromSettings(nil, defaults)
	}
	if err != nil {
		return ratelimit.Config{}, err
	}
	return ratelimit.ConfigFromSettings(raw, defaults)
}

// RunRateLimitReload polls the settings every interval and applies changes
// to the limiter until ctx is done.
func (s *Server) RunRateLimitReload(ctx context.Context, interval time.Duration) {
	if s.limiter == nil {
		return
	}
	reload := func() {
		loadCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		cfg, err := s.loadRateLimitConfig(loadCtx)
		if err != nil {
			slog.Warn("ratelimit: settings reload failed; keeping the previous limits", "err", err)
			return
		}
		if s.limiter.Reload(cfg) {
			slog.Info("ratelimit: limits updated", "anonymous", orUnlimited(cfg.Anonymous.String()),
				"authenticated", orUnlimited(cfg.Authenticated.String()), "trustedProxies", len(cfg.TrustedProxies))
		}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reload()
		}
	}
}

func orUnlimited(s string) string {
	if s == "" {
		return "unlimited"
	}
	return s
}
