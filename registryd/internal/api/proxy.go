package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"registryd/internal/config"
	"registryd/internal/hooks"
	"registryd/internal/manifest"
	"registryd/internal/storage"
	"registryd/internal/store"
	"registryd/internal/upstream"
)

// Pull-through proxy cache. An organization can mirror an upstream registry
// on demand: manifests and blobs that are missing (or whose tag check has
// expired) are fetched from the upstream, stored exactly like a push, and
// then served by the normal handlers — so dedup, quotas, events, the push
// webhook (scanning, repository webhooks) and the pull policy all apply.
//
// Configuration (upstream URL, decrypted credentials, allow-list, TTL) comes
// from the web app's internal API, because credentials are encrypted with a
// key only the web app holds; it is cached for a minute, refreshed early on
// an upstream 401, on a nested-name miss, and by POST /internal/v1/proxies/reload.

const (
	proxyConfigTTL      = 60 * time.Second
	proxyRefreshMinGap  = 5 * time.Second
	proxyConfigTimeout  = 10 * time.Second
	proxyMaxDownloads   = 8
	proxyStatusInterval = 30 * time.Second

	// CodeUnavailable is returned when an upstream cannot be reached and
	// nothing is cached locally (not an OCI spec code; clients print it).
	CodeUnavailable = "UNAVAILABLE"
)

// proxyOrg is the effective proxy configuration of one organization.
type proxyOrg struct {
	OrgID     string
	Slug      string
	Upstream  string
	Host      string
	Preset    string
	DockerHub bool
	Patterns  string
	TTL       time.Duration
	Enabled   bool
	username  string
	password  string
	client    *upstream.Client
}

// proxyRegistry caches proxy configurations and coordinates downloads.
type proxyRegistry struct {
	cfg  *config.Config
	http *http.Client

	mu          sync.Mutex
	bySlug      map[string]*proxyOrg
	fetchedAt   time.Time
	lastAttempt time.Time
	status      map[string]proxyStatus

	refresh   upstream.Group
	downloads upstream.Group
	sem       chan struct{}
}

type proxyStatus struct {
	at  time.Time
	msg string
}

func newProxyRegistry(cfg *config.Config) *proxyRegistry {
	return &proxyRegistry{
		cfg:    cfg,
		http:   &http.Client{Timeout: proxyConfigTimeout},
		bySlug: map[string]*proxyOrg{},
		status: map[string]proxyStatus{},
		sem:    make(chan struct{}, proxyMaxDownloads),
	}
}

// proxyConfigJSON mirrors the web app's GET /api/internal/proxies payload.
type proxyConfigJSON struct {
	OrganizationID  string `json:"organizationId"`
	Slug            string `json:"slug"`
	UpstreamURL     string `json:"upstreamUrl"`
	Preset          string `json:"preset"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	AllowedPatterns string `json:"allowedPatterns"`
	TagTTLSeconds   int    `json:"tagTtlSeconds"`
	Enabled         bool   `json:"enabled"`
}

// lookup returns the proxy configuration for an organization slug, or nil.
// A cold cache is loaded synchronously; a stale one is served while it
// refreshes in the background. With nested=true (a multi-component name
// that only makes sense in a proxy organization) a miss triggers an early,
// throttled refresh so freshly created proxies work immediately.
func (p *proxyRegistry) lookup(ctx context.Context, slug string, nested bool) *proxyOrg {
	p.mu.Lock()
	cold := p.fetchedAt.IsZero()
	stale := time.Since(p.fetchedAt) > proxyConfigTTL
	px := p.bySlug[slug]
	p.mu.Unlock()

	switch {
	case cold || (nested && px == nil):
		p.reload(ctx)
		p.mu.Lock()
		px = p.bySlug[slug]
		p.mu.Unlock()
	case stale:
		go p.reload(context.Background())
	}
	return px
}

// invalidate forces the next lookup to fetch a fresh configuration.
func (p *proxyRegistry) invalidate() {
	p.mu.Lock()
	p.fetchedAt = time.Time{}
	p.lastAttempt = time.Time{}
	p.mu.Unlock()
}

// reload fetches the configuration, deduplicating concurrent callers and
// never hammering the web app more often than every few seconds.
func (p *proxyRegistry) reload(ctx context.Context) {
	p.mu.Lock()
	if time.Since(p.lastAttempt) < proxyRefreshMinGap {
		p.mu.Unlock()
		// Join an in-flight refresh if there is one, otherwise keep the data.
		p.refresh.Do(ctx, "config", func(context.Context) (any, error) { return nil, nil })
		return
	}
	p.lastAttempt = time.Now()
	p.mu.Unlock()
	res := p.refresh.Do(ctx, "config", func(ctx context.Context) (any, error) { return nil, p.fetch(ctx) })
	if res.Err != nil {
		slog.Warn("proxy: configuration refresh failed", "err", res.Err)
	}
}

func (p *proxyRegistry) fetch(ctx context.Context) error {
	if p.cfg.InternalAPIURL == "" || p.cfg.WebhookSecret == "" {
		p.mu.Lock()
		p.fetchedAt = time.Now()
		p.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, proxyConfigTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.cfg.InternalAPIURL, "/")+"/proxies", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.cfg.WebhookSecret)
	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("internal API answered HTTP %d", resp.StatusCode)
	}
	var body struct {
		Proxies []proxyConfigJSON `json:"proxies"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return fmt.Errorf("decode proxy configuration: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	next := make(map[string]*proxyOrg, len(body.Proxies))
	for _, c := range body.Proxies {
		if c.Slug == "" || c.OrganizationID == "" {
			continue
		}
		px := &proxyOrg{
			OrgID:     c.OrganizationID,
			Slug:      c.Slug,
			Upstream:  strings.TrimRight(strings.TrimSpace(c.UpstreamURL), "/"),
			Preset:    c.Preset,
			DockerHub: upstream.IsDockerHub(c.UpstreamURL),
			Patterns:  c.AllowedPatterns,
			TTL:       time.Duration(c.TagTTLSeconds) * time.Second,
			Enabled:   c.Enabled,
			username:  c.Username,
			password:  c.Password,
		}
		if u, err := url.Parse(px.Upstream); err == nil {
			px.Host = u.Host
		}
		if px.TTL <= 0 {
			px.TTL = 5 * time.Minute
		}
		// Keep the client (and its cached tokens) when nothing relevant changed.
		if old := p.bySlug[c.Slug]; old != nil && old.Upstream == px.Upstream &&
			old.username == px.username && old.password == px.password {
			px.client = old.client
		} else {
			px.client = upstream.NewClient(px.Upstream, px.username, px.password)
			slug := c.Slug
			px.client.OnRequest = func(method, u string) {
				slog.Info("proxy: upstream request", "org", slug, "method", method, "url", u)
			}
		}
		next[c.Slug] = px
	}
	p.bySlug = next
	p.fetchedAt = time.Now()
	return nil
}

// proxyFor returns the proxy configuration of an organization, or nil.
func (s *Server) proxyFor(ctx context.Context, slug string) *proxyOrg {
	return s.proxies.lookup(ctx, slug, false)
}

// handleProxyReload lets the web app push configuration changes immediately
// instead of waiting for the cache to expire.
func (s *Server) handleProxyReload(w http.ResponseWriter, r *http.Request) {
	if !s.internalAuthorized(r) {
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "invalid credential")
		return
	}
	s.proxies.invalidate()
	s.proxies.reload(r.Context())
	s.proxies.mu.Lock()
	n := len(s.proxies.bySlug)
	s.proxies.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"proxies": n})
}

// --- Manifests ---

var errUpstreamManifest = errors.New("upstream manifest invalid")

// ensureProxiedManifest makes sure the manifest a client asked for is cached
// locally and fresh, fetching it from the upstream when needed. It returns
// false when it already wrote a response (an error); true lets the regular
// handler serve the local copy (or report its absence).
func (s *Server) ensureProxiedManifest(w http.ResponseWriter, r *http.Request, rc *reqCtx, px *proxyOrg, ref string) bool {
	ctx := r.Context()
	upstreamPath := upstream.UpstreamPath(px.DockerHub, rc.repo)
	// The allow-list gates upstream contact; images cached while they were
	// allowed stay pullable, exactly like when the proxy is paused.
	allowed := upstream.Allowed(px.Patterns, upstreamPath)
	repo, err := s.store.GetRepository(ctx, rc.org, rc.repo)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeInternal(w, r, err)
		return false
	}

	if isDigest(ref) {
		if repo != nil {
			exists, err := s.store.ManifestExists(ctx, repo.ID, ref)
			if err != nil {
				writeInternal(w, r, err)
				return false
			}
			if exists {
				return true
			}
		}
		if !px.Enabled {
			return true
		}
		if !allowed {
			s.writeNotAllowed(w, rc, upstreamPath)
			return false
		}
		m, err := px.client.GetManifest(ctx, upstreamPath, ref)
		if err != nil {
			s.noteProxyStatus(px, err)
			s.writeUpstreamError(w, r, px, err, "manifest")
			return false
		}
		s.noteProxyStatus(px, nil)
		return s.storeProxiedManifestOrFail(w, r, rc, px, m, "")
	}

	if !tagRe.MatchString(ref) {
		return true // the regular handler reports TAG_INVALID
	}
	var localDigest string
	var checkedAt *time.Time
	if repo != nil {
		d, c, err := s.store.ProxyTagState(ctx, repo.ID, ref)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			writeInternal(w, r, err)
			return false
		}
		localDigest, checkedAt = d, c
	}
	fresh := localDigest != "" && checkedAt != nil && time.Since(*checkedAt) < px.TTL
	if fresh || !px.Enabled {
		return true
	}
	if !allowed {
		if localDigest != "" {
			return true
		}
		s.writeNotAllowed(w, rc, upstreamPath)
		return false
	}

	// Revalidate a cached tag with a HEAD (free on Docker Hub); a first fetch
	// goes straight to GET so it costs a single request.
	var m *upstream.Manifest
	if localDigest != "" {
		head, err := px.client.HeadManifest(ctx, upstreamPath, ref)
		if err == nil && head.Digest == localDigest {
			s.noteProxyStatus(px, nil)
			repoID := repo.ID
			go func() {
				ctx, cancel := contextWithTimeout()
				defer cancel()
				if err := s.store.TouchProxyTag(ctx, repoID, ref); err != nil {
					slog.Warn("proxy: touch tag failed", "repo", repoID, "tag", ref, "err", err)
				}
			}()
			return true
		}
		if err == nil {
			m, err = px.client.GetManifest(ctx, upstreamPath, ref)
		}
		if err != nil {
			s.noteProxyStatus(px, err)
			slog.Warn("proxy: upstream check failed, serving cached tag", "org", px.Slug, "repo", rc.repo, "tag", ref, "err", err)
			return true
		}
	} else {
		var err error
		m, err = px.client.GetManifest(ctx, upstreamPath, ref)
		if err != nil {
			s.noteProxyStatus(px, err)
			s.writeUpstreamError(w, r, px, err, "manifest")
			return false
		}
	}
	s.noteProxyStatus(px, nil)
	return s.storeProxiedManifestOrFail(w, r, rc, px, m, ref)
}

func (s *Server) storeProxiedManifestOrFail(w http.ResponseWriter, r *http.Request, rc *reqCtx, px *proxyOrg, m *upstream.Manifest, tag string) bool {
	if err := s.storeProxiedManifest(r.Context(), rc, px, m, tag); err != nil {
		if errors.Is(err, errUpstreamManifest) {
			writeError(w, http.StatusBadGateway, CodeUnavailable, err.Error())
			return false
		}
		writeStoreError(w, r, err)
		return false
	}
	return true
}

// storeProxiedManifest persists a fetched manifest the way a push does:
// repository auto-creation (quotas checked), manifest row and references,
// the tag, a push event with actor "proxy", and the push webhook so the web
// app caches the config, runs repository webhooks and scans the image.
func (s *Server) storeProxiedManifest(ctx context.Context, rc *reqCtx, px *proxyOrg, m *upstream.Manifest, tag string) error {
	parsed, err := manifest.Parse(m.MediaType, m.Payload)
	if err != nil {
		return fmt.Errorf("%w: %v", errUpstreamManifest, err)
	}
	if err := s.proxyManifestQuota(ctx, px.OrgID, parsed); err != nil {
		return err
	}
	repo, err := s.proxyRepository(ctx, rc, px)
	if err != nil {
		return err
	}
	row := &store.Manifest{
		RepositoryID: repo.ID,
		Digest:       m.Digest,
		MediaType:    parsed.MediaType,
		ArtifactType: parsed.ArtifactType,
		Size:         int64(len(m.Payload)),
		Payload:      m.Payload,
		PushedBy:     "proxy",
	}
	if parsed.Config != nil {
		row.ConfigDigest = parsed.Config.Digest
	}
	if parsed.Subject != nil {
		row.SubjectDigest = parsed.Subject.Digest
	}
	if err := s.store.UpsertManifest(ctx, row, parsed.References()); err != nil {
		return err
	}
	if tag != "" {
		if err := s.store.UpsertProxyTag(ctx, repo.ID, tag, m.Digest); err != nil {
			return err
		}
	}
	_ = s.store.TouchRepository(ctx, repo.ID)
	s.recordEvent(&store.Event{
		RepositoryID: repo.ID, Type: "push", ActorType: "proxy",
		ManifestDigest: m.Digest, Tag: tag,
	})
	s.notifier.Notify(hooks.Event{
		Type: "manifest.push", Repository: rc.org + "/" + rc.repo, Digest: m.Digest, Tag: tag,
		MediaType: parsed.MediaType, Actor: "proxy",
	})
	slog.Info("proxy: cached manifest", "org", px.Slug, "repo", rc.repo, "tag", tag, "digest", m.Digest, "upstream", px.Host)
	return nil
}

// proxyManifestQuota refuses to cache an image whose layers would exceed
// the organization's storage limits — blobs the organization already holds
// are free, as with pushes — so a denied pull leaves nothing behind. Index
// manifests carry no layers; their children are checked when fetched.
func (s *Server) proxyManifestQuota(ctx context.Context, orgID string, parsed *manifest.Parsed) error {
	descriptors := parsed.Layers
	if parsed.Config != nil {
		descriptors = append(append([]manifest.Descriptor{}, descriptors...), *parsed.Config)
	}
	var needed int64
	for _, d := range descriptors {
		if manifest.IsForeignLayer(d.MediaType) || d.Size <= 0 {
			continue
		}
		has, err := s.store.OrgHasBlob(ctx, orgID, d.Digest)
		if err != nil {
			return err
		}
		if !has {
			needed += d.Size
		}
	}
	if needed == 0 {
		return nil
	}
	return s.store.CheckStorageQuota(ctx, orgID, needed)
}

func (s *Server) writeNotAllowed(w http.ResponseWriter, rc *reqCtx, upstreamPath string) {
	writeError(w, http.StatusForbidden, CodeDenied,
		fmt.Sprintf("%s is not allowed by the proxy configuration of organization %q", upstreamPath, rc.org))
}

// proxyRepository resolves the local repository, creating it on first use
// with the organization's default visibility once the repository quota
// allows it (the proxy has no user of its own).
func (s *Server) proxyRepository(ctx context.Context, rc *reqCtx, px *proxyOrg) (*store.Repository, error) {
	repo, err := s.store.GetRepository(ctx, rc.org, rc.repo)
	if err == nil {
		return repo, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	visibility, err := s.store.DefaultVisibility(ctx, px.OrgID, "proxy", "")
	if err != nil {
		return nil, err
	}
	if err := s.store.CheckRepositoryQuota(ctx, px.OrgID, visibility); err != nil {
		return nil, err
	}
	return s.store.EnsureRepository(ctx, rc.org, rc.repo, visibility)
}

// noteProxyPull records the pull time of a tag (eviction is based on it).
func (s *Server) noteProxyPull(repoID, tag string) {
	go func() {
		ctx, cancel := contextWithTimeout()
		defer cancel()
		_ = s.store.TouchTagPulled(ctx, repoID, tag)
	}()
}

// --- Blobs ---

// ensureProxiedBlob fetches a blob a cached manifest references but the
// repository does not hold yet. Concurrent requests for the same digest
// share one download; content another repository already stores is linked
// without touching the upstream. Returns false when a response was written.
func (s *Server) ensureProxiedBlob(w http.ResponseWriter, r *http.Request, rc *reqCtx, px *proxyOrg, repo *store.Repository, digest string) bool {
	ctx := r.Context()
	upstreamPath := upstream.UpstreamPath(px.DockerHub, rc.repo)
	referenced, err := s.store.IsManifestReference(ctx, repo.ID, digest)
	if err != nil {
		writeInternal(w, r, err)
		return false
	}
	if !referenced {
		return true // only blobs a cached manifest needs are fetched
	}

	size, known, err := s.store.BlobExists(ctx, digest)
	if err != nil {
		writeInternal(w, r, err)
		return false
	}
	if !known {
		if !px.Enabled {
			return true
		}
		if !upstream.Allowed(px.Patterns, upstreamPath) {
			s.writeNotAllowed(w, rc, upstreamPath)
			return false
		}
		orgID := repo.OrgID
		res := s.proxies.downloads.Do(ctx, digest, func(ctx context.Context) (any, error) {
			return s.downloadProxiedBlob(ctx, px, orgID, upstreamPath, digest)
		})
		if res.Err != nil {
			if r.Context().Err() != nil {
				writeError(w, http.StatusServiceUnavailable, CodeUnavailable, "request cancelled")
				return false
			}
			if store.IsQuotaError(res.Err) {
				writeStoreError(w, r, res.Err)
				return false
			}
			s.noteProxyStatus(px, res.Err)
			s.writeUpstreamError(w, r, px, res.Err, "blob")
			return false
		}
		size = res.Val.(int64)
		s.noteProxyStatus(px, nil)
	}

	// Link (dedup or freshly downloaded) — new content for this organization
	// counts against its storage quota.
	if err := s.proxyStorageQuota(ctx, repo.OrgID, digest, size); err != nil {
		writeStoreError(w, r, err)
		return false
	}
	if err := s.store.UpsertBlob(ctx, repo.ID, digest, size, ""); err != nil {
		writeInternal(w, r, err)
		return false
	}
	return true
}

// proxyStorageQuota applies the storage limits when the blob is new to the
// organization.
func (s *Server) proxyStorageQuota(ctx context.Context, orgID, digest string, size int64) error {
	has, err := s.store.OrgHasBlob(ctx, orgID, digest)
	if err != nil || has {
		return err
	}
	return s.store.CheckStorageQuota(ctx, orgID, size)
}

// downloadProxiedBlob streams a blob from the upstream into the staging
// area, verifies its digest, commits it to storage and registers the blob
// row. Runs once per digest under the download group.
func (s *Server) downloadProxiedBlob(ctx context.Context, px *proxyOrg, orgID, upstreamPath, digest string) (any, error) {
	select {
	case s.proxies.sem <- struct{}{}:
		defer func() { <-s.proxies.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	body, size, err := px.client.OpenBlob(ctx, upstreamPath, digest)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	if size >= 0 {
		if err := s.proxyStorageQuota(ctx, orgID, digest, size); err != nil {
			return nil, err
		}
	}

	id := uuid.NewString()
	if err := s.staging.Create(ctx, id, "proxy", digest); err != nil {
		return nil, err
	}
	defer s.staging.Remove(ctx, id)
	n, err := s.staging.Append(ctx, id, 0, body)
	if err != nil {
		return nil, fmt.Errorf("upstream transfer of %s failed: %w", digest, err)
	}
	if size >= 0 && n != size {
		return nil, fmt.Errorf("upstream transfer of %s ended after %d of %d bytes", digest, n, size)
	}
	actual, n, err := storage.StagedDigest(ctx, s.staging, id)
	if err != nil {
		return nil, err
	}
	if actual != digest {
		return nil, fmt.Errorf("%w: %s served as %s", upstream.ErrDigest, actual, digest)
	}
	if size < 0 {
		if err := s.proxyStorageQuota(ctx, orgID, digest, n); err != nil {
			return nil, err
		}
	}
	if _, err := s.driver.Stat(ctx, digest); errors.Is(err, storage.ErrNotFound) {
		content, _, err := s.staging.Open(ctx, id)
		if err != nil {
			return nil, err
		}
		err = s.driver.Put(ctx, digest, content, n)
		content.Close()
		if err != nil {
			return nil, fmt.Errorf("store blob: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	if err := s.store.RegisterBlob(ctx, digest, n); err != nil {
		return nil, err
	}
	slog.Info("proxy: cached blob", "org", px.Slug, "digest", digest, "bytes", n, "upstream", px.Host)
	return n, nil
}

// --- Errors and status ---

// writeUpstreamError maps a fetch failure to an OCI error response.
func (s *Server) writeUpstreamError(w http.ResponseWriter, r *http.Request, px *proxyOrg, err error, what string) {
	slog.Warn("proxy: upstream error", "org", px.Slug, "upstream", px.Host, "path", r.URL.Path, "err", err)
	switch {
	case errors.Is(err, upstream.ErrNotFound):
		code := CodeManifestUnknown
		if what == "blob" {
			code = CodeBlobUnknown
		}
		writeError(w, http.StatusNotFound, code, fmt.Sprintf("%s not found on upstream %s", what, px.Host))
	case errors.Is(err, upstream.ErrUnauthorized):
		// Credentials may have just been rotated in the web app.
		s.proxies.invalidate()
		writeError(w, http.StatusBadGateway, CodeUnavailable,
			fmt.Sprintf("upstream %s rejected the proxy credentials of organization %q; check its proxy settings", px.Host, px.Slug))
	case errors.Is(err, upstream.ErrDenied):
		writeError(w, http.StatusForbidden, CodeDenied, fmt.Sprintf("upstream %s denied access: %v", px.Host, err))
	case errors.Is(err, upstream.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, CodeTooManyRequests,
			fmt.Sprintf("upstream %s rate limit reached; add credentials to the proxy settings of %q", px.Host, px.Slug))
	case store.IsQuotaError(err):
		writeError(w, http.StatusForbidden, CodeDenied, err.Error())
	default:
		writeError(w, http.StatusBadGateway, CodeUnavailable,
			fmt.Sprintf("could not fetch %s from upstream %s: %v", what, px.Host, err))
	}
}

// noteProxyStatus persists last_checked_at / last_error for the admin UI,
// writing at most every 30 s per organization unless the message changes.
func (s *Server) noteProxyStatus(px *proxyOrg, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
	}
	p := s.proxies
	p.mu.Lock()
	last := p.status[px.OrgID]
	if last.msg == msg && time.Since(last.at) < proxyStatusInterval {
		p.mu.Unlock()
		return
	}
	p.status[px.OrgID] = proxyStatus{at: time.Now(), msg: msg}
	p.mu.Unlock()
	orgID := px.OrgID
	go func() {
		ctx, cancel := contextWithTimeout()
		defer cancel()
		if err := s.store.SetProxyStatus(ctx, orgID, msg); err != nil {
			slog.Warn("proxy: status update failed", "org", orgID, "err", err)
		}
	}()
}
