package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestRouteTemplate(t *testing.T) {
	cases := map[string]string{
		"/v2":                                    "base",
		"/v2/":                                   "base",
		"/v2/_catalog":                           "catalog",
		"/v2/acme/app/manifests/latest":          "manifest",
		"/v2/acme/app/manifests/sha256:abc":      "manifest",
		"/v2/nginx/manifests/1.27":               "manifest",
		"/v2/hub/library/nginx/manifests/latest": "manifest",
		"/v2/hub/a/b/c/manifests/v1":             "manifest",
		"/v2/acme/app/blobs/sha256:abc":          "blob",
		"/v2/acme/app/blobs/uploads/":            "upload",
		"/v2/acme/app/blobs/uploads":             "upload",
		"/v2/acme/app/blobs/uploads/0f3c-4d":     "upload",
		"/v2/acme/app/tags/list":                 "tags",
		"/v2/acme/app/referrers/sha256:abc":      "referrers",
		"/v2/acme/manifests/blobs/sha256:abc":    "blob", // repo literally named "manifests"
		"/v2/acme/app":                           "other",
		"/v2/acme/app/manifests":                 "other",
		"/v2/acme/app/tags":                      "other",
		"/v2/acme/app/blobs/sha256:abc/extra":    "other",
		"/metrics":                               "metrics",
		"/internal/v1/metrics":                   "metrics",
		"/internal/v1/healthz":                   "internal",
		"/internal/v1/gc":                        "internal",
		"/":                                      "other",
		"/favicon.ico":                           "other",
		"/v2/../etc":                             "other",
	}
	for path, want := range cases {
		if got := RouteTemplate(path); got != want {
			t.Errorf("RouteTemplate(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestMethodLabel(t *testing.T) {
	if methodLabel("GET") != "GET" || methodLabel("PATCH") != "PATCH" {
		t.Fatal("known verbs must pass through")
	}
	if methodLabel("PROPFIND") != "OTHER" || methodLabel("get") != "OTHER" {
		t.Fatal("unknown verbs must collapse to OTHER")
	}
}

func TestNilMetricsAreInert(t *testing.T) {
	var m *Metrics
	m.ObserveRequest("GET", "/v2/", 200, time.Millisecond)
	m.InFlight(1)
	m.AddUploadBytes(10)
	m.AddBlobBytes("stream", 10)
	m.RateLimited(true)
	m.Upstream("blob", "ok")
	m.CacheHit("blob")
	m.CacheMiss("manifest")
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("nil handler status = %d, want 404", rec.Code)
	}
}

func TestExposition(t *testing.T) {
	m := New(Options{Version: "1.2.3", GoVersion: "go1.26", Driver: "filesystem", StagingFree: func() int64 { return 4096 }})
	m.ObserveRequest("GET", "/v2/acme/app/manifests/latest", 200, 20*time.Millisecond)
	m.ObserveRequest("GET", "/v2/acme/app/manifests/latest", 404, time.Millisecond)
	m.ObserveRequest("PUT", "/v2/acme/app/blobs/uploads/abc", 201, time.Second)
	m.AddUploadBytes(1500)
	m.AddBlobBytes("stream", 100)
	m.AddBlobBytes("redirect", 200)
	m.AddBlobBytes("stream", -5) // ignored
	m.RateLimited(true)
	m.RateLimited(false)
	m.RateLimited(false)
	m.Upstream("manifest", "ok")
	m.Upstream("blob", "not_found")
	m.CacheHit("manifest")
	m.CacheMiss("blob")
	m.InFlight(1)

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`chicoree_registryd_http_requests_total{method="GET",route="manifest",status="200"} 1`,
		`chicoree_registryd_http_requests_total{method="GET",route="manifest",status="404"} 1`,
		`chicoree_registryd_http_requests_total{method="PUT",route="upload",status="201"} 1`,
		`chicoree_registryd_http_request_duration_seconds_count{route="manifest"} 2`,
		`chicoree_registryd_http_in_flight 1`,
		`chicoree_registryd_upload_bytes_total 1500`,
		`chicoree_registryd_blob_bytes_served_total{mode="redirect"} 200`,
		`chicoree_registryd_blob_bytes_served_total{mode="stream"} 100`,
		`chicoree_registryd_rate_limited_total{subject="anonymous"} 1`,
		`chicoree_registryd_rate_limited_total{subject="authenticated"} 2`,
		`chicoree_registryd_proxy_upstream_requests_total{kind="blob",result="not_found"} 1`,
		`chicoree_registryd_proxy_upstream_requests_total{kind="manifest",result="ok"} 1`,
		`chicoree_registryd_proxy_cache_hits_total{kind="manifest"} 1`,
		`chicoree_registryd_proxy_cache_misses_total{kind="blob"} 1`,
		`chicoree_registryd_staging_free_bytes 4096`,
		`chicoree_registryd_storage_driver_info{driver="filesystem"} 1`,
		`chicoree_registryd_build_info{go="go1.26",version="1.2.3"} 1`,
		`go_goroutines `,
		`process_resident_memory_bytes `,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition lacks %q", want)
		}
	}
	if got := testutil.ToFloat64(m.uploadBytes); got != 1500 {
		t.Fatalf("upload bytes = %v", got)
	}
	if strings.Contains(body, "acme") {
		t.Fatal("repository names must never appear as labels")
	}
}
