// Package api implements the OCI Distribution Specification HTTP API plus a
// small internal surface (health, garbage collection) for the web app.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"registryd/internal/auth"
	"registryd/internal/config"
	"registryd/internal/hooks"
	"registryd/internal/metrics"
	"registryd/internal/ratelimit"
	"registryd/internal/storage"
	"registryd/internal/store"
	"registryd/internal/traffic"
	"registryd/internal/upstream"
)

// Server wires the API handlers to their dependencies.
type Server struct {
	cfg      *config.Config
	store    *store.Store
	driver   storage.Driver
	staging  storage.Staging
	verifier *auth.Verifier
	notifier *hooks.Notifier
	// proxies holds the pull-through proxy configuration (see proxy.go).
	proxies *proxyRegistry
	started time.Time
	// Optional: pull rate limiting (see ratelimit.go) and traffic accounting
	// (see traffic.go); nil disables the feature.
	limiter *ratelimit.Manager
	// Throttle for "the shared counter is unreachable" warnings.
	limiterLogMu    sync.Mutex
	limiterLoggedAt time.Time
	traffic         *traffic.Counter
	// Rename/transfer redirects (see redirects.go): the cached tables and the
	// lookups resolution needs (the store, or a fake in tests).
	redirects  *redirectCache
	repoLookup store.RepoLookup
	// Prometheus collectors (always on; nil-safe) and the gate that decides
	// whether GET /metrics serves them (see metrics.go).
	metrics     *metrics.Metrics
	metricsGate *metricsGate
}

func NewServer(cfg *config.Config, st *store.Store, driver storage.Driver, staging storage.Staging, verifier *auth.Verifier, notifier *hooks.Notifier) *Server {
	s := &Server{cfg: cfg, store: st, driver: driver, staging: staging, verifier: verifier, notifier: notifier,
		proxies: newProxyRegistry(cfg), started: time.Now(),
		redirects: newRedirectCache(st.LoadRedirects), repoLookup: st}
	s.metrics = s.newMetrics()
	return s
}

var (
	nameRe   = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$`)
	tagRe    = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$`)
	digestRe = regexp.MustCompile(`^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-f0-9]{32,}$`)
)

func isDigest(s string) bool { return digestRe.MatchString(s) }

// Handler returns the root http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/", s.routeV2)
	mux.HandleFunc("/v2", s.routeV2)
	mux.HandleFunc("GET /internal/v1/healthz", s.handleHealthz)
	mux.HandleFunc("GET /internal/v1/status", s.handleStatus)
	mux.HandleFunc("POST /internal/v1/gc", s.handleGC)
	mux.HandleFunc("POST /internal/v1/proxies/reload", s.handleProxyReload)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /internal/v1/metrics", s.handleMetrics)
	return logMiddleware(mux, s.metrics)
}

// logMiddleware logs every request and feeds the request counters and
// latency histogram (m may be nil).
func logMiddleware(next http.Handler, m *metrics.Metrics) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		m.InFlight(1)
		next.ServeHTTP(rec, r)
		m.InFlight(-1)
		elapsed := time.Since(start)
		m.ObserveRequest(r.Method, r.URL.Path, rec.status, elapsed)
		slog.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"dur", elapsed.Round(time.Millisecond).String())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// routeV2 dispatches OCI distribution paths. Repository names are restricted
// to exactly two components, <org>/<repo>, except in proxy-cache
// organizations, where the upstream path may have any depth
// (<proxy>/<a>/<b>/…): the repository is everything before the route marker.
func (s *Server) routeV2(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v2")
	path = strings.TrimPrefix(path, "/")

	if path == "" {
		s.handleBase(w, r)
		return
	}
	if path == "_catalog" {
		s.handleCatalog(w, r)
		return
	}

	segs := strings.Split(path, "/")
	// Two shapes: <org>/<repo>/... or the top-level <repo>/..., which lives in
	// the "library" organization (docker.io semantics: `nginx` == `library/nginx`).
	var name, org, repo string
	var rest []string
	switch {
	case len(segs) >= 3 && isRouteMarker(segs[1]):
		name, org, repo = segs[0], LibraryOrg, segs[0]
		rest = segs[1:]
	case len(segs) >= 5 && !isRouteMarker(segs[2]):
		// Nested name: only proxy-cache organizations accept these.
		marker := -1
		for i := 3; i < len(segs); i++ {
			if isRouteMarker(segs[i]) {
				marker = i
				break
			}
		}
		if marker < 0 {
			writeError(w, http.StatusNotFound, CodeNameUnknown, "unknown route")
			return
		}
		if s.proxies.lookup(r.Context(), segs[0], true) == nil {
			writeError(w, http.StatusNotFound, CodeNameUnknown,
				"repository paths are <org>/<repo>; deeper paths are only available in proxy-cache organizations")
			return
		}
		org, repo = segs[0], strings.Join(segs[1:marker], "/")
		name = org + "/" + repo
		rest = segs[marker:]
	case len(segs) >= 4:
		name, org, repo = segs[0]+"/"+segs[1], segs[0], segs[1]
		rest = segs[2:]
	default:
		writeError(w, http.StatusNotFound, CodeNameUnknown, "unknown route; repository paths are <org>/<repo> or <repo>")
		return
	}
	if !nameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, CodeNameInvalid, "invalid repository name; expected <org>/<repo> or <repo> with lowercase components")
		return
	}
	_, _ = org, repo // resolved again inside withAuth from the request name

	switch {
	case len(rest) == 2 && rest[0] == "tags" && rest[1] == "list":
		s.withAuth(w, r, name, "pull", s.handleTagsList)
	case len(rest) == 2 && rest[0] == "manifests":
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			s.withAuth(w, r, name, "pull", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
				s.handleManifestGet(w, r, rc, rest[1])
			})
		case http.MethodPut:
			s.withAuth(w, r, name, "push", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
				s.handleManifestPut(w, r, rc, rest[1])
			})
		case http.MethodDelete:
			s.withAuth(w, r, name, "delete", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
				s.handleManifestDelete(w, r, rc, rest[1])
			})
		default:
			writeError(w, http.StatusMethodNotAllowed, CodeUnsupported, "method not allowed")
		}
	case len(rest) == 2 && rest[0] == "referrers":
		s.withAuth(w, r, name, "pull", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
			s.handleReferrers(w, r, rc, rest[1])
		})
	case rest[0] == "blobs" && len(rest) >= 2 && rest[1] == "uploads":
		// POST /blobs/uploads/ (trailing slash yields an empty final segment)
		if r.Method == http.MethodPost && (len(rest) == 2 || (len(rest) == 3 && rest[2] == "")) {
			s.withAuth(w, r, name, "push", s.handleUploadStart)
			return
		}
		if len(rest) == 3 && rest[2] != "" {
			id := rest[2]
			switch r.Method {
			case http.MethodPatch:
				s.withAuth(w, r, name, "push", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
					s.handleUploadPatch(w, r, rc, id)
				})
			case http.MethodPut:
				s.withAuth(w, r, name, "push", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
					s.handleUploadCommit(w, r, rc, id)
				})
			case http.MethodGet:
				s.withAuth(w, r, name, "pull", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
					s.handleUploadStatus(w, r, rc, id)
				})
			case http.MethodDelete:
				s.withAuth(w, r, name, "push", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
					s.handleUploadCancel(w, r, rc, id)
				})
			default:
				writeError(w, http.StatusMethodNotAllowed, CodeUnsupported, "method not allowed")
			}
			return
		}
		writeError(w, http.StatusNotFound, CodeBlobUploadUnknown, "unknown upload route")
	case rest[0] == "blobs" && len(rest) == 2:
		digest := rest[1]
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			s.withAuth(w, r, name, "pull", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
				s.handleBlobGet(w, r, rc, digest)
			})
		case http.MethodDelete:
			s.withAuth(w, r, name, "delete", func(w http.ResponseWriter, r *http.Request, rc *reqCtx) {
				s.handleBlobDelete(w, r, rc, digest)
			})
		default:
			writeError(w, http.StatusMethodNotAllowed, CodeUnsupported, "method not allowed")
		}
	default:
		writeError(w, http.StatusNotFound, CodeNameUnknown, "unknown route")
	}
}

// LibraryOrg is the organization that owns top-level image names.
const LibraryOrg = "library"

// isRouteMarker reports whether a path segment starts an API sub-path; a
// name segment followed by one of these is a top-level (library) repository.
func isRouteMarker(seg string) bool {
	switch seg {
	case "manifests", "blobs", "tags", "referrers":
		return true
	}
	return false
}

// reqCtx carries the authenticated identity and target repository through a
// request.
type reqCtx struct {
	identity *auth.Identity
	name     string // the name as requested: "org/repo" or top-level "repo"
	org      string // resolved organization slug ("library" for top-level names)
	repo     string
}

type authedHandler func(http.ResponseWriter, *http.Request, *reqCtx)

// withAuth enforces token auth for a repository-scoped route. A missing or
// invalid token yields 401 with a challenge; a valid token without the
// required grant yields 403.
func (s *Server) withAuth(w http.ResponseWriter, r *http.Request, name, action string, next authedHandler) {
	org, repo, ok := strings.Cut(name, "/")
	if !ok {
		org, repo = LibraryOrg, name
	} else if px := s.proxyFor(r.Context(), org); px != nil {
		// Proxy organizations store Docker Hub library images under their
		// short name, so <proxy>/library/nginx and <proxy>/nginx coincide.
		repo = upstream.LocalName(px.DockerHub, repo)
	}
	s.withAuthResolved(w, r, name, org, repo, action, next)
}

func (s *Server) withAuthResolved(w http.ResponseWriter, r *http.Request, name, org, repo, action string, next authedHandler) {
	identity, err := s.verifier.Identify(r)
	scope := auth.RepositoryScope(name, requestScopeActions(action)...)
	if err != nil {
		s.verifier.Challenge(w, scope)
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "invalid or expired token")
		return
	}
	if identity == nil {
		s.verifier.Challenge(w, scope)
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "authentication required")
		return
	}
	if !s.verifier.Disabled() && !identity.Can("repository", name, action) {
		// Tokens for a former repository name only ever carry pull (the token
		// endpoint authorizes the old name against the target, read-only), so
		// a push or delete lands here: say where the repository went.
		if action != "pull" {
			if moved, err := s.resolveMoved(r.Context(), org, repo); err == nil && moved != nil {
				writeError(w, http.StatusForbidden, CodeDenied, movedMessage(moved))
				return
			}
		}
		writeError(w, http.StatusForbidden, CodeDenied, "access to the requested resource is denied")
		return
	}
	next(w, r, &reqCtx{identity: identity, name: name, org: org, repo: repo})
}

// requestScopeActions widens the challenge scope so clients request a token
// covering the whole operation (docker asks for pull,push when pushing).
func requestScopeActions(action string) []string {
	switch action {
	case "push":
		return []string{"pull", "push"}
	case "delete":
		return []string{"delete"}
	default:
		return []string{"pull"}
	}
}

// handleBase implements GET /v2/ — the API version check that also drives the
// token handshake.
func (s *Server) handleBase(w http.ResponseWriter, r *http.Request) {
	identity, err := s.verifier.Identify(r)
	if err != nil || (identity == nil && !s.verifier.Disabled()) {
		s.verifier.Challenge(w, "")
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "authentication required")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{}\n"))
}

// recordEvent persists an event without blocking the request path.
func (s *Server) recordEvent(e *store.Event) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.store.RecordEvent(ctx, e); err != nil {
			slog.Warn("record event failed", "type", e.Type, "repo", e.RepositoryID, "err", err)
		}
	}()
}
