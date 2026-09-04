package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"registryd/internal/config"
	"registryd/internal/upstream"
)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestParseMetricsSettings(t *testing.T) {
	hash := sha256Hex("scrape-me")
	cases := []struct {
		name    string
		raw     string
		enabled bool
		wantErr bool
	}{
		{"no row", "", false, false},
		{"enabled with hash", fmt.Sprintf(`{"enabled":true,"token":"v1:x:y:z","tokenHash":%q}`, hash), true, false},
		{"disabled with hash", fmt.Sprintf(`{"enabled":false,"tokenHash":%q}`, hash), false, false},
		{"enabled without hash (pre-upgrade row)", `{"enabled":true,"token":"v1:x:y:z"}`, false, false},
		{"bad hash", `{"enabled":true,"tokenHash":"nope"}`, false, true},
		{"short hash", `{"enabled":true,"tokenHash":"abcd"}`, false, true},
		{"garbage", `{"enabled":`, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var raw []byte
			if c.raw != "" {
				raw = []byte(c.raw)
			}
			enabled, got, err := parseMetricsSettings(raw)
			if (err != nil) != c.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, c.wantErr)
			}
			if enabled != c.enabled {
				t.Fatalf("enabled = %v, want %v", enabled, c.enabled)
			}
			if enabled && hex.EncodeToString(got) != hash {
				t.Fatalf("hash = %x, want %s", got, hash)
			}
		})
	}
}

func metricsRequest(path, header string) *http.Request {
	r := httptest.NewRequest("GET", path, nil)
	if header != "" {
		r.Header.Set("Authorization", header)
	}
	return r
}

func TestMetricsGate(t *testing.T) {
	sum := sha256.Sum256([]byte("panel-token"))

	t.Run("nothing configured", func(t *testing.T) {
		g := &metricsGate{}
		if g.active() {
			t.Fatal("gate must be inactive without settings or env token")
		}
		if g.authorized(metricsRequest("/metrics", "Bearer anything")) {
			t.Fatal("nothing may authorize")
		}
	})

	t.Run("settings token", func(t *testing.T) {
		g := &metricsGate{}
		g.set(true, sum[:])
		if !g.active() {
			t.Fatal("gate must be active")
		}
		cases := map[string]bool{
			"Bearer panel-token":  true,
			"Bearer panel-token ": true, // trailing whitespace tolerated
			"Bearer PANEL-TOKEN":  false,
			"Bearer ":             false,
			"Basic panel-token":   false,
			"":                    false,
			"Bearer env-token":    false,
		}
		for header, want := range cases {
			if got := g.authorized(metricsRequest("/metrics", header)); got != want {
				t.Errorf("header %q: authorized = %v, want %v", header, got, want)
			}
		}
	})

	t.Run("env token only", func(t *testing.T) {
		g := &metricsGate{envToken: "env-token"}
		if !g.active() {
			t.Fatal("env token must activate the gate")
		}
		if !g.authorized(metricsRequest("/metrics", "Bearer env-token")) {
			t.Fatal("env token must authorize")
		}
		if g.authorized(metricsRequest("/metrics", "Bearer panel-token")) {
			t.Fatal("unknown token must not authorize")
		}
	})

	t.Run("both configured", func(t *testing.T) {
		g := &metricsGate{envToken: "env-token"}
		g.set(true, sum[:])
		for _, h := range []string{"Bearer env-token", "Bearer panel-token"} {
			if !g.authorized(metricsRequest("/metrics", h)) {
				t.Errorf("%q must authorize", h)
			}
		}
	})

	t.Run("disabling in the panel keeps env", func(t *testing.T) {
		g := &metricsGate{envToken: "env-token"}
		g.set(true, sum[:])
		if !g.set(false, nil) {
			t.Fatal("set must report the change")
		}
		if !g.active() || g.authorized(metricsRequest("/metrics", "Bearer panel-token")) {
			t.Fatal("panel token must stop working once the section is off")
		}
		if !g.authorized(metricsRequest("/metrics", "Bearer env-token")) {
			t.Fatal("env token must keep working")
		}
	})

	t.Run("set reports unchanged", func(t *testing.T) {
		g := &metricsGate{}
		g.set(true, sum[:])
		if g.set(true, sum[:]) {
			t.Fatal("identical gate must not count as a change")
		}
	})
}

func TestHandleMetrics(t *testing.T) {
	s := &Server{cfg: &config.Config{StagingDir: t.TempDir()}}
	s.metrics = s.newMetrics()

	rec := httptest.NewRecorder()
	s.handleMetrics(rec, metricsRequest("/metrics", "Bearer x"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unconfigured: status = %d, want 404", rec.Code)
	}

	sum := sha256.Sum256([]byte("panel-token"))
	s.metricsGate = &metricsGate{}
	s.metricsGate.set(true, sum[:])

	rec = httptest.NewRecorder()
	s.handleMetrics(rec, metricsRequest("/metrics", ""))
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") == "" {
		t.Fatalf("no token: status = %d, challenge %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	rec = httptest.NewRecorder()
	s.handleMetrics(rec, metricsRequest("/metrics", "Bearer wrong"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status = %d, want 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	s.handleMetrics(rec, metricsRequest("/metrics", "Bearer panel-token"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"chicoree_registryd_build_info", "chicoree_registryd_staging_free_bytes", "go_goroutines"} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition lacks %s", want)
		}
	}
}

func TestMiddlewareInstrumentsRequests(t *testing.T) {
	s := &Server{cfg: &config.Config{StagingDir: t.TempDir()}}
	s.metrics = s.newMetrics()
	sum := sha256.Sum256([]byte("tok"))
	s.metricsGate = &metricsGate{}
	s.metricsGate.set(true, sum[:])

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.metrics == nil {
			t.Fatal("metrics missing")
		}
		w.WriteHeader(http.StatusTeapot)
	})
	h := logMiddleware(inner, s.metrics)
	for range 3 {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/v2/acme/app/manifests/latest", nil))
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("HEAD", "/v2/acme/app/blobs/sha256:abc", nil))

	rec := httptest.NewRecorder()
	s.handleMetrics(rec, metricsRequest("/metrics", "Bearer tok"))
	body := rec.Body.String()
	for _, want := range []string{
		`chicoree_registryd_http_requests_total{method="GET",route="manifest",status="418"} 3`,
		`chicoree_registryd_http_requests_total{method="HEAD",route="blob",status="418"} 1`,
		`chicoree_registryd_http_in_flight 0`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition lacks %q\n%s", want, body)
		}
	}
}

func TestUpstreamResult(t *testing.T) {
	cases := map[string]error{
		"ok":           nil,
		"not_found":    upstream.ErrNotFound,
		"unauthorized": fmt.Errorf("wrapped: %w", upstream.ErrUnauthorized),
		"denied":       upstream.ErrDenied,
		"rate_limited": upstream.ErrRateLimited,
		"error":        errors.New("connection reset"),
	}
	for want, err := range cases {
		if got := upstreamResult(err); got != want {
			t.Errorf("upstreamResult(%v) = %q, want %q", err, got, want)
		}
	}
}
