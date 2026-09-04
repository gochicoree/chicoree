package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"registryd/internal/metrics"
	"registryd/internal/store"
	"registryd/internal/upstream"
	"registryd/internal/version"
)

// metricsGate decides whether GET /metrics is served and which bearer token
// it needs. The admin panel's "metrics" section (instance_settings) carries
// a sha256 of the scrape token — the token itself is stored encrypted with
// a key only the web app has — and METRICS_TOKEN in the environment is the
// fallback for installs configured without the panel. Either credential is
// accepted while it is configured.
type metricsGate struct {
	mu        sync.RWMutex
	enabled   bool   // the settings section is on and carries a hash
	tokenHash []byte // sha256 of the settings token
	envToken  string
}

// metricsSettings is the JSON shape of the instance_settings "metrics" row.
// "token" (encrypted) is deliberately not read.
type metricsSettings struct {
	Enabled   bool   `json:"enabled"`
	TokenHash string `json:"tokenHash"`
}

// parseMetricsSettings extracts the gate facts from the stored row. A row
// that is enabled but has no hash (saved before the hash existed) counts as
// disabled: nothing could authenticate against it.
func parseMetricsSettings(raw []byte) (enabled bool, hash []byte, err error) {
	if raw == nil {
		return false, nil, nil
	}
	var s metricsSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		return false, nil, fmt.Errorf("metrics settings: %w", err)
	}
	if !s.Enabled || s.TokenHash == "" {
		return false, nil, nil
	}
	h, err := hex.DecodeString(strings.TrimSpace(s.TokenHash))
	if err != nil || len(h) != sha256.Size {
		return false, nil, fmt.Errorf("metrics settings: tokenHash is not a sha256 hex digest")
	}
	return true, h, nil
}

func (g *metricsGate) set(enabled bool, hash []byte) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	changed := g.enabled != enabled || subtle.ConstantTimeCompare(g.tokenHash, hash) != 1
	g.enabled, g.tokenHash = enabled, hash
	return changed
}

// active reports whether the endpoint answers at all.
func (g *metricsGate) active() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.enabled || g.envToken != ""
}

// authorized checks a bearer token against the configured credentials.
func (g *metricsGate) authorized(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	token = strings.TrimSpace(token)
	if !ok || token == "" {
		return false
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.enabled && len(g.tokenHash) == sha256.Size {
		sum := sha256.Sum256([]byte(token))
		if subtle.ConstantTimeCompare(sum[:], g.tokenHash) == 1 {
			return true
		}
	}
	if g.envToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(g.envToken)) == 1 {
		return true
	}
	return false
}

// newMetrics builds the collector set for this process.
func (s *Server) newMetrics() *metrics.Metrics {
	driver := ""
	if s.driver != nil {
		driver = s.driver.Name()
	}
	staging := s.cfg.StagingDir
	return metrics.New(metrics.Options{
		Version:     version.Version,
		GoVersion:   runtime.Version(),
		Driver:      driver,
		StagingFree: func() int64 { return diskFreeBytes(staging) },
	})
}

// ConfigureMetrics loads the endpoint gate from the settings row and the
// environment. Pair it with RunMetricsReload so enabling the endpoint in
// the admin panel takes effect without a restart.
func (s *Server) ConfigureMetrics(ctx context.Context) error {
	s.metricsGate = &metricsGate{envToken: s.cfg.MetricsToken}
	if err := s.loadMetricsGate(ctx); err != nil {
		return err
	}
	slog.Info("metrics: endpoint", "enabled", s.metricsGate.active(), "settings", s.metricsGate.enabled, "envToken", s.cfg.MetricsToken != "")
	return nil
}

func (s *Server) loadMetricsGate(ctx context.Context) error {
	raw, err := s.store.InstanceSetting(ctx, "metrics")
	if errors.Is(err, store.ErrNotFound) {
		raw = nil
	} else if err != nil {
		return err
	}
	enabled, hash, err := parseMetricsSettings(raw)
	if err != nil {
		return err
	}
	if s.metricsGate.set(enabled, hash) {
		slog.Info("metrics: settings applied", "enabled", enabled)
	}
	return nil
}

// RunMetricsReload polls the settings row every interval until ctx is done.
func (s *Server) RunMetricsReload(ctx context.Context, interval time.Duration) {
	if s.metricsGate == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			loadCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := s.loadMetricsGate(loadCtx); err != nil {
				slog.Warn("metrics: settings reload failed; keeping the previous gate", "err", err)
			}
			cancel()
		}
	}
}

// handleMetrics serves the Prometheus exposition: 404 while nothing enables
// the endpoint, 401 without the right bearer token.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if s.metricsGate == nil || !s.metricsGate.active() {
		writeError(w, http.StatusNotFound, CodeUnsupported, "metrics endpoint is disabled")
		return
	}
	if !s.metricsGate.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "invalid metrics credential")
		return
	}
	s.metrics.Handler().ServeHTTP(w, r)
}

// upstreamResult maps a proxy fetch error to the bounded result label.
func upstreamResult(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, upstream.ErrNotFound):
		return "not_found"
	case errors.Is(err, upstream.ErrUnauthorized):
		return "unauthorized"
	case errors.Is(err, upstream.ErrDenied):
		return "denied"
	case errors.Is(err, upstream.ErrRateLimited):
		return "rate_limited"
	}
	return "error"
}

// noteUpstream counts one upstream contact of the proxy.
func (s *Server) noteUpstream(kind string, err error) {
	s.metrics.Upstream(kind, upstreamResult(err))
}
