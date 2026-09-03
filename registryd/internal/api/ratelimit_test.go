package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"registryd/internal/auth"
	"registryd/internal/ratelimit"
)

func TestPullLimitExempt(t *testing.T) {
	admin := &auth.Identity{Subject: "user:1", Access: []auth.AccessGrant{{Type: "registry", Name: "catalog", Actions: []string{"*"}}}}
	user := &auth.Identity{Subject: "user:2", Access: []auth.AccessGrant{{Type: "repository", Name: "acme/app", Actions: []string{"pull"}}}}
	cases := map[*auth.Identity]bool{
		admin:                       true,
		user:                        false,
		{Subject: "user:system"}:    true,
		{Subject: "mirror:abc"}:     true,
		{Subject: "proxy:upstream"}: true,
		{Subject: "sa:1"}:           false,
		{Subject: "anonymous"}:      false,
		nil:                         false,
	}
	for id, want := range cases {
		if got := pullLimitExempt(id); got != want {
			t.Errorf("pullLimitExempt(%+v) = %v, want %v", id, got, want)
		}
	}
}

func TestSetRateLimitHeaders(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	d := ratelimit.Decision{
		Allowed:   true,
		Limit:     ratelimit.Limit{Count: 100, Window: 6 * time.Hour},
		Remaining: 42,
		Reset:     now.Add(90*time.Minute + 300*time.Millisecond),
	}
	h := http.Header{}
	setRateLimitHeaders(h, d, now)
	want := map[string]string{
		"RateLimit-Limit":     "100",
		"RateLimit-Policy":    "100;w=21600",
		"RateLimit-Remaining": "42",
		"RateLimit-Reset":     "5401", // rounded up to whole seconds
	}
	for k, v := range want {
		if got := rateLimitHeader(h, k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	// The keys keep the draft's casing instead of Go's canonical "Ratelimit-".
	if _, ok := h["RateLimit-Limit"]; !ok {
		t.Errorf("header keys were canonicalised: %v", h)
	}
}

func TestEnforcePullLimit(t *testing.T) {
	cfg, err := ratelimit.ConfigFromSettings(nil, ratelimit.Settings{Anonymous: "2/1m", Authenticated: "1/1m", TrustedProxies: "10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{limiter: ratelimit.NewManager(cfg)}
	anon := &reqCtx{identity: &auth.Identity{Subject: "anonymous"}}
	req := func(remote, xff string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/v2/acme/app/manifests/latest", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}

	// Two anonymous pulls from one address pass, the third is refused.
	for i := 1; i <= 2; i++ {
		rec := httptest.NewRecorder()
		if !s.enforcePullLimit(rec, req("203.0.113.5:1000", ""), anon) {
			t.Fatalf("anonymous request %d should pass", i)
		}
		if rateLimitHeader(rec.Header(), "RateLimit-Limit") != "2" || rateLimitHeader(rec.Header(), "RateLimit-Remaining") != strings.TrimSpace(string(rune('0'+2-i))) {
			t.Errorf("request %d headers: %v", i, rec.Header())
		}
	}
	rec := httptest.NewRecorder()
	if s.enforcePullLimit(rec, req("203.0.113.5:1001", ""), anon) {
		t.Fatal("third anonymous request should be refused")
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" || rateLimitHeader(rec.Header(), "RateLimit-Remaining") != "0" || rateLimitHeader(rec.Header(), "RateLimit-Reset") == "" {
		t.Errorf("429 headers: %v", rec.Header())
	}
	var body ociErrors
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Errors) != 1 || body.Errors[0].Code != CodeTooManyRequests {
		t.Errorf("429 body = %s", rec.Body.String())
	}

	// Another address (via a trusted proxy's X-Forwarded-For) has its own budget.
	if !s.enforcePullLimit(httptest.NewRecorder(), req("10.0.0.1:2000", "198.51.100.7"), anon) {
		t.Error("forwarded client should have a fresh budget")
	}
	// The same forwarded address through an untrusted peer is keyed by the peer.
	if !s.enforcePullLimit(httptest.NewRecorder(), req("192.0.2.1:2000", "203.0.113.5"), anon) {
		t.Error("untrusted peer must not inherit the forwarded client's exhausted budget")
	}

	// Authenticated users draw from their own (per subject) budget.
	user := &reqCtx{identity: &auth.Identity{Subject: "user:42"}}
	if !s.enforcePullLimit(httptest.NewRecorder(), req("203.0.113.5:3000", ""), user) {
		t.Error("first authenticated request should pass")
	}
	if s.enforcePullLimit(httptest.NewRecorder(), req("203.0.113.5:3000", ""), user) {
		t.Error("second authenticated request should be refused (limit 1)")
	}
	other := &reqCtx{identity: &auth.Identity{Subject: "sa:7"}}
	if !s.enforcePullLimit(httptest.NewRecorder(), req("203.0.113.5:3000", ""), other) {
		t.Error("a different subject has its own budget")
	}

	// Admins are exempt and get no rate-limit headers.
	admin := &reqCtx{identity: &auth.Identity{Subject: "user:1", Access: []auth.AccessGrant{{Type: "registry", Name: "catalog", Actions: []string{"*"}}}}}
	rec = httptest.NewRecorder()
	for i := 0; i < 5; i++ {
		if !s.enforcePullLimit(rec, req("203.0.113.5:4000", ""), admin) {
			t.Fatal("admin should never be limited")
		}
	}
	if rateLimitHeader(rec.Header(), "RateLimit-Limit") != "" {
		t.Error("exempt identities should not see rate-limit headers")
	}

	// No limiter configured at all: everything passes silently.
	if !(&Server{}).enforcePullLimit(httptest.NewRecorder(), req("203.0.113.5:5000", ""), anon) {
		t.Error("server without limiter must not limit")
	}
	// A class without a limit passes without headers.
	unlimited, _ := ratelimit.ConfigFromSettings(nil, ratelimit.Settings{Anonymous: "1/1m"})
	s2 := &Server{limiter: ratelimit.NewManager(unlimited)}
	rec = httptest.NewRecorder()
	if !s2.enforcePullLimit(rec, req("203.0.113.5:6000", ""), user) || rateLimitHeader(rec.Header(), "RateLimit-Limit") != "" {
		t.Error("authenticated class without a limit should pass without headers")
	}
}
