// Package metrics holds registryd's Prometheus collectors. The process keeps
// only what the database cannot tell: request counts and latencies, bytes
// moved, rate-limit and proxy decisions, and Go runtime facts. Everything is
// labelled with a bounded vocabulary (route templates, modes, results) —
// never repository names, which are the web app's per-repository metrics.
package metrics

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const namespace = "chicoree_registryd"

// Options describe the process for the info gauges.
type Options struct {
	Version   string
	GoVersion string
	Driver    string
	// StagingFree reports the bytes available on the staging filesystem
	// (-1 when unknown); read on every scrape.
	StagingFree func() int64
}

// Metrics is the collector set. A nil *Metrics is inert: every method is a
// no-op, so code paths can be instrumented without checking for it.
type Metrics struct {
	registry *prometheus.Registry

	requests    *prometheus.CounterVec
	duration    *prometheus.HistogramVec
	inFlight    prometheus.Gauge
	uploadBytes prometheus.Counter
	blobBytes   *prometheus.CounterVec
	rateLimited *prometheus.CounterVec
	upstream    *prometheus.CounterVec
	cacheHits   *prometheus.CounterVec
	cacheMisses *prometheus.CounterVec
}

// New builds the registry with the default Go and process collectors plus
// the registryd series.
func New(o Options) *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	m := &Metrics{
		registry: reg,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "http_requests_total",
			Help: "HTTP requests by method, route template and status code.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace, Name: "http_request_duration_seconds",
			Help:    "Request latency by route template (blob transfers included, so the tail is long).",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 300},
		}, []string{"route"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace, Name: "http_in_flight",
			Help: "Requests currently being served.",
		}),
		uploadBytes: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace, Name: "upload_bytes_total",
			Help: "Bytes received for committed blob uploads and manifest pushes.",
		}),
		blobBytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "blob_bytes_served_total",
			Help: "Blob bytes handed to clients: streamed by registryd, or the blob size when the client was redirected to the storage backend.",
		}, []string{"mode"}),
		rateLimited: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "rate_limited_total",
			Help: "Requests refused with 429 by the pull rate limit, by subject kind.",
		}, []string{"subject"}),
		upstream: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "proxy_upstream_requests_total",
			Help: "Requests the pull-through proxy made to upstream registries, by kind and result.",
		}, []string{"kind", "result"}),
		cacheHits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "proxy_cache_hits_total",
			Help: "Proxy-cache requests answered from the local copy.",
		}, []string{"kind"}),
		cacheMisses: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Name: "proxy_cache_misses_total",
			Help: "Proxy-cache requests that had to fetch from the upstream.",
		}, []string{"kind"}),
	}
	reg.MustRegister(m.requests, m.duration, m.inFlight, m.uploadBytes, m.blobBytes, m.rateLimited,
		m.upstream, m.cacheHits, m.cacheMisses)

	// Info gauges and the staging probe.
	build := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace, Name: "build_info",
		Help: "Build facts of the running registryd; always 1.",
	}, []string{"version", "go"})
	build.WithLabelValues(o.Version, o.GoVersion).Set(1)
	driver := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace, Name: "storage_driver_info",
		Help: "Configured blob storage driver; always 1.",
	}, []string{"driver"})
	driver.WithLabelValues(o.Driver).Set(1)
	reg.MustRegister(build, driver)
	if o.StagingFree != nil {
		reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: namespace, Name: "staging_free_bytes",
			Help: "Bytes available on the filesystem holding the upload staging directory (-1 when unknown).",
		}, func() float64 { return float64(o.StagingFree()) }))
	}

	// Pre-create the series alerts rely on, so a fresh process exposes 0
	// rather than nothing.
	for _, mode := range []string{"stream", "redirect"} {
		m.blobBytes.WithLabelValues(mode)
	}
	for _, subject := range []string{"anonymous", "authenticated"} {
		m.rateLimited.WithLabelValues(subject)
	}
	for _, kind := range []string{"manifest", "blob"} {
		m.cacheHits.WithLabelValues(kind)
		m.cacheMisses.WithLabelValues(kind)
		m.upstream.WithLabelValues(kind, "ok")
		m.upstream.WithLabelValues(kind, "error")
	}
	return m
}

// Handler serves the exposition (gzip negotiated by promhttp).
func (m *Metrics) Handler() http.Handler {
	if m == nil {
		return http.NotFoundHandler()
	}
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Gatherer exposes the registry, for tests.
func (m *Metrics) Gatherer() prometheus.Gatherer {
	if m == nil {
		return nil
	}
	return m.registry
}

// ObserveRequest records one finished request.
func (m *Metrics) ObserveRequest(method, path string, status int, d time.Duration) {
	if m == nil {
		return
	}
	route := RouteTemplate(path)
	m.requests.WithLabelValues(methodLabel(method), route, strconv.Itoa(status)).Inc()
	m.duration.WithLabelValues(route).Observe(d.Seconds())
}

// InFlight moves the in-flight gauge by delta (+1 on entry, -1 on exit).
func (m *Metrics) InFlight(delta float64) {
	if m == nil {
		return
	}
	m.inFlight.Add(delta)
}

// AddUploadBytes counts bytes received.
func (m *Metrics) AddUploadBytes(n int64) {
	if m == nil || n <= 0 {
		return
	}
	m.uploadBytes.Add(float64(n))
}

// AddBlobBytes counts bytes served; mode is "stream" or "redirect".
func (m *Metrics) AddBlobBytes(mode string, n int64) {
	if m == nil || n <= 0 {
		return
	}
	m.blobBytes.WithLabelValues(mode).Add(float64(n))
}

// RateLimited counts a 429 answer.
func (m *Metrics) RateLimited(anonymous bool) {
	if m == nil {
		return
	}
	subject := "authenticated"
	if anonymous {
		subject = "anonymous"
	}
	m.rateLimited.WithLabelValues(subject).Inc()
}

// Upstream counts one request to an upstream registry; kind is "manifest"
// or "blob", result one of ok, not_found, unauthorized, denied,
// rate_limited, error.
func (m *Metrics) Upstream(kind, result string) {
	if m == nil {
		return
	}
	m.upstream.WithLabelValues(kind, result).Inc()
}

// CacheHit counts a proxied request served locally.
func (m *Metrics) CacheHit(kind string) {
	if m == nil {
		return
	}
	m.cacheHits.WithLabelValues(kind).Inc()
}

// CacheMiss counts a proxied request that went upstream.
func (m *Metrics) CacheMiss(kind string) {
	if m == nil {
		return
	}
	m.cacheMisses.WithLabelValues(kind).Inc()
}

// methodLabel keeps the method label to the verbs the API serves.
func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return method
	}
	return "OTHER"
}

// RouteTemplate maps a request path to a low-cardinality route name:
//
//	/v2/                                 base
//	/v2/_catalog                         catalog
//	/v2/<name>/manifests/<ref>           manifest
//	/v2/<name>/blobs/uploads[/<id>]      upload
//	/v2/<name>/blobs/<digest>            blob
//	/v2/<name>/tags/list                 tags
//	/v2/<name>/referrers/<digest>        referrers
//	/metrics, /internal/v1/metrics       metrics
//	/internal/…                          internal
//	anything else                        other
//
// The repository name may contain any number of components, so the route is
// decided by the last marker segment rather than by position.
func RouteTemplate(path string) string {
	switch {
	case path == "/metrics" || path == "/internal/v1/metrics":
		return "metrics"
	case strings.HasPrefix(path, "/internal/"):
		return "internal"
	case path == "/v2" || path == "/v2/":
		return "base"
	case path == "/v2/_catalog":
		return "catalog"
	case !strings.HasPrefix(path, "/v2/"):
		return "other"
	}
	segs := strings.Split(strings.Trim(strings.TrimPrefix(path, "/v2/"), "/"), "/")
	for i := len(segs) - 1; i >= 1; i-- {
		switch segs[i] {
		case "manifests":
			if i == len(segs)-2 {
				return "manifest"
			}
		case "referrers":
			if i == len(segs)-2 {
				return "referrers"
			}
		case "tags":
			if i == len(segs)-2 && segs[i+1] == "list" {
				return "tags"
			}
		case "blobs":
			rest := segs[i+1:]
			switch {
			case len(rest) >= 1 && rest[0] == "uploads":
				return "upload"
			case len(rest) == 1:
				return "blob"
			}
		}
	}
	return "other"
}
