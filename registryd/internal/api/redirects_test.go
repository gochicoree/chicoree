package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"registryd/internal/auth"
	"registryd/internal/store"
)

type fakeRepoLookup struct {
	repos map[string]*store.Repository
	byID  map[string]*store.RepositoryRef
	orgs  map[string]string
}

func (f *fakeRepoLookup) GetRepository(_ context.Context, org, name string) (*store.Repository, error) {
	if r, ok := f.repos[org+"/"+name]; ok {
		return r, nil
	}
	return nil, store.ErrNotFound
}

func (f *fakeRepoLookup) GetRepositoryByID(_ context.Context, id string) (*store.RepositoryRef, error) {
	if r, ok := f.byID[id]; ok {
		return r, nil
	}
	return nil, store.ErrNotFound
}

func (f *fakeRepoLookup) OrgIDBySlug(_ context.Context, slug string) (string, error) {
	if id, ok := f.orgs[slug]; ok {
		return id, nil
	}
	return "", store.ErrNotFound
}

// testServer wires a Server with fake lookups only: acme/alpine was renamed
// to acme/alpine2 (id x). No database, no storage.
func testServer(t *testing.T) *Server {
	t.Helper()
	target := &store.RepositoryRef{
		Repository: store.Repository{ID: "x", OrgID: "org-a", Visibility: "public"},
		OrgSlug:    "acme", Name: "alpine2",
	}
	lookup := &fakeRepoLookup{
		repos: map[string]*store.Repository{"acme/alpine2": &target.Repository},
		byID:  map[string]*store.RepositoryRef{"x": target},
		orgs:  map[string]string{"acme": "org-a"},
	}
	loads := 0
	cache := newRedirectCache(func(context.Context) (*store.RedirectTable, error) {
		loads++
		return store.NewRedirectTable(nil, []store.RepoRedirect{{OrgSlug: "acme", Name: "alpine", RepositoryID: "x"}}), nil
	})
	return &Server{repoLookup: lookup, redirects: cache}
}

func identity() *auth.Identity {
	return &auth.Identity{Subject: "user:dev", Access: []auth.AccessGrant{{Type: "repository", Name: "acme/alpine", Actions: []string{"pull"}}}}
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) (code, message string) {
	t.Helper()
	var body struct {
		Errors []struct{ Code, Message string }
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || len(body.Errors) == 0 {
		t.Fatalf("no OCI error body: %v (%s)", err, rec.Body.String())
	}
	return body.Errors[0].Code, body.Errors[0].Message
}

func TestLookupRepoReadFollowsRedirect(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	repo, err := s.lookupRepoRead(ctx, &reqCtx{name: "acme/alpine", org: "acme", repo: "alpine"})
	if err != nil || repo == nil || repo.ID != "x" {
		t.Fatalf("old name must resolve to the target: %+v, %v", repo, err)
	}
	repo, err = s.lookupRepoRead(ctx, &reqCtx{name: "acme/alpine2", org: "acme", repo: "alpine2"})
	if err != nil || repo == nil || repo.ID != "x" {
		t.Fatalf("current name must resolve directly: %+v, %v", repo, err)
	}
	if _, err := s.lookupRepoRead(ctx, &reqCtx{name: "acme/other", org: "acme", repo: "other"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown name without redirect: got %v, want ErrNotFound", err)
	}
}

func TestManifestPutToMovedNameIsRefused(t *testing.T) {
	s := testServer(t)
	manifest := `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:` + strings.Repeat("a", 64) + `","size":2},"layers":[]}`
	r := httptest.NewRequest(http.MethodPut, "/v2/acme/alpine/manifests/3.20", strings.NewReader(manifest))
	r.Header.Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
	rec := httptest.NewRecorder()
	s.handleManifestPut(rec, r, &reqCtx{identity: identity(), name: "acme/alpine", org: "acme", repo: "alpine"}, "3.20")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	code, msg := decodeError(t, rec)
	if code != CodeDenied || !strings.HasPrefix(msg, "repository moved to acme/alpine2; push to the new name") {
		t.Fatalf("unexpected error %s: %s", code, msg)
	}
}

func TestDeletesAgainstMovedNameAreRefused(t *testing.T) {
	s := testServer(t)
	rc := &reqCtx{identity: identity(), name: "acme/alpine", org: "acme", repo: "alpine"}

	rec := httptest.NewRecorder()
	s.handleManifestDelete(rec, httptest.NewRequest(http.MethodDelete, "/v2/acme/alpine/manifests/3.20", nil), rc, "3.20")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("manifest delete status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	if code, msg := decodeError(t, rec); code != CodeDenied || !strings.Contains(msg, "moved to acme/alpine2") {
		t.Fatalf("manifest delete: %s %s", code, msg)
	}

	rec = httptest.NewRecorder()
	digest := "sha256:" + strings.Repeat("b", 64)
	s.handleBlobDelete(rec, httptest.NewRequest(http.MethodDelete, "/v2/acme/alpine/blobs/"+digest, nil), rc, digest)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("blob delete status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}

	// A name nobody ever used stays a plain 404.
	rec = httptest.NewRecorder()
	other := &reqCtx{identity: identity(), name: "acme/other", org: "acme", repo: "other"}
	s.handleManifestDelete(rec, httptest.NewRequest(http.MethodDelete, "/v2/acme/other/manifests/1", nil), other, "1")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown name status = %d, want 404", rec.Code)
	}
}

func TestRedirectCacheTTL(t *testing.T) {
	loads := 0
	c := newRedirectCache(func(context.Context) (*store.RedirectTable, error) {
		loads++
		return store.NewRedirectTable(nil, nil), nil
	})
	c.ttl = 50 * time.Millisecond
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := c.get(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if loads != 1 {
		t.Fatalf("loads within the TTL = %d, want 1", loads)
	}
	time.Sleep(60 * time.Millisecond)
	if _, err := c.get(ctx); err != nil {
		t.Fatal(err)
	}
	if loads != 2 {
		t.Fatalf("loads after the TTL = %d, want 2", loads)
	}
	c.invalidate()
	if _, err := c.get(ctx); err != nil {
		t.Fatal(err)
	}
	if loads != 3 {
		t.Fatalf("loads after invalidate = %d, want 3", loads)
	}

	// A failing reload keeps the previous snapshot.
	fail := newRedirectCache(func(context.Context) (*store.RedirectTable, error) { return nil, errors.New("db down") })
	if _, err := fail.get(ctx); err == nil {
		t.Fatal("first load failure must surface")
	}
	fail.table, fail.fetchedAt = store.NewRedirectTable(nil, nil), time.Time{}
	if tbl, err := fail.get(ctx); err != nil || tbl == nil {
		t.Fatalf("stale snapshot must be served on reload failure: %v", err)
	}
}
