package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"registryd/internal/store"
)

// Renamed and transferred repositories (and renamed organizations) leave a
// row in repository_redirects / organization_redirects. When a name is
// unknown, the read paths (manifest GET/HEAD, tags list, referrers, blob
// GET/HEAD) resolve it through those tables and serve the target
// transparently; write paths refuse with 403 DENIED and point at the new
// name. The tables are tiny, so they are loaded whole and cached briefly.

const redirectCacheTTL = 30 * time.Second

type redirectCache struct {
	load func(ctx context.Context) (*store.RedirectTable, error)
	ttl  time.Duration

	mu        sync.Mutex
	table     *store.RedirectTable
	fetchedAt time.Time
}

func newRedirectCache(load func(ctx context.Context) (*store.RedirectTable, error)) *redirectCache {
	return &redirectCache{load: load, ttl: redirectCacheTTL}
}

// get returns the cached snapshot, reloading it when stale. A failed reload
// keeps serving the previous snapshot (and logs) rather than failing pulls.
func (c *redirectCache) get(ctx context.Context) (*store.RedirectTable, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.table != nil && time.Since(c.fetchedAt) < c.ttl {
		return c.table, nil
	}
	t, err := c.load(ctx)
	if err != nil {
		if c.table != nil {
			slog.Warn("redirects: reload failed, serving cached snapshot", "err", err)
			return c.table, nil
		}
		return nil, err
	}
	c.table, c.fetchedAt = t, time.Now()
	return t, nil
}

// invalidate forces the next get to reload.
func (c *redirectCache) invalidate() {
	c.mu.Lock()
	c.table, c.fetchedAt = nil, time.Time{}
	c.mu.Unlock()
}

// resolveMoved finds the repository a former name points at, or nil.
func (s *Server) resolveMoved(ctx context.Context, org, repo string) (*store.RepositoryRef, error) {
	if s.redirects == nil || s.repoLookup == nil {
		return nil, nil
	}
	table, err := s.redirects.get(ctx)
	if err != nil {
		return nil, err
	}
	return store.ResolveMoved(ctx, table, s.repoLookup, org, repo)
}

// lookupRepoRead resolves the repository for a read: the exact name first,
// then the redirect tables. ErrNotFound when neither knows it.
func (s *Server) lookupRepoRead(ctx context.Context, rc *reqCtx) (*store.Repository, error) {
	repo, err := s.repoLookup.GetRepository(ctx, rc.org, rc.repo)
	if err == nil || !errors.Is(err, store.ErrNotFound) {
		return repo, err
	}
	moved, err := s.resolveMoved(ctx, rc.org, rc.repo)
	if err != nil {
		return nil, err
	}
	if moved == nil {
		return nil, store.ErrNotFound
	}
	slog.Info("redirect", "from", rc.name, "to", moved.Path())
	return &moved.Repository, nil
}

// movedMessage is the 403 body for writes against a former name.
func movedMessage(moved *store.RepositoryRef) string {
	return fmt.Sprintf("repository moved to %s; push to the new name (create a repository with the old name in the web UI to reuse it)", moved.Path())
}

// writeMovedIfRedirected answers 403 DENIED when the name is a former name of
// a repository and reports whether it did. Writes and deletes call it before
// reporting a repository as unknown (or auto-creating it).
func (s *Server) writeMovedIfRedirected(w http.ResponseWriter, r *http.Request, rc *reqCtx) bool {
	moved, err := s.resolveMoved(r.Context(), rc.org, rc.repo)
	if err != nil {
		writeInternal(w, r, err)
		return true
	}
	if moved == nil {
		return false
	}
	writeError(w, http.StatusForbidden, CodeDenied, movedMessage(moved))
	return true
}
