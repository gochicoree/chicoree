package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

// fakeLookup answers repository lookups from maps, in place of the database.
type fakeLookup struct {
	repos map[string]*Repository    // "org/name" → repository
	byID  map[string]*RepositoryRef // id → current name
	orgs  map[string]string         // slug → id
	calls []string
}

func (f *fakeLookup) GetRepository(_ context.Context, org, name string) (*Repository, error) {
	f.calls = append(f.calls, "repo:"+org+"/"+name)
	if r, ok := f.repos[org+"/"+name]; ok {
		return r, nil
	}
	return nil, ErrNotFound
}

func (f *fakeLookup) GetRepositoryByID(_ context.Context, id string) (*RepositoryRef, error) {
	f.calls = append(f.calls, "id:"+id)
	if r, ok := f.byID[id]; ok {
		return r, nil
	}
	return nil, ErrNotFound
}

func (f *fakeLookup) OrgIDBySlug(_ context.Context, slug string) (string, error) {
	f.calls = append(f.calls, "org:"+slug)
	if id, ok := f.orgs[slug]; ok {
		return id, nil
	}
	return "", ErrNotFound
}

func TestResolveMovedOrder(t *testing.T) {
	ctx := context.Background()
	// gamma (id org-g) used to be "acme"; its repository "alpine2" (id x) used
	// to be acme/alpine; beta (id org-b) received "web" (id y) from acme.
	table := NewRedirectTable(
		[]OrgRedirect{{OldSlug: "acme", OrgID: "org-g", Slug: "gamma"}},
		[]RepoRedirect{
			{OrgSlug: "acme", Name: "alpine", RepositoryID: "x"},
			{OrgSlug: "acme", Name: "web", RepositoryID: "y"},
		},
	)
	x := &RepositoryRef{Repository: Repository{ID: "x", OrgID: "org-g", Visibility: "public"}, OrgSlug: "gamma", Name: "alpine2"}
	y := &RepositoryRef{Repository: Repository{ID: "y", OrgID: "org-b", Visibility: "private"}, OrgSlug: "beta", Name: "web"}
	newLookup := func() *fakeLookup {
		return &fakeLookup{
			repos: map[string]*Repository{
				"gamma/alpine2": &x.Repository,
				"gamma/nginx":   {ID: "n", OrgID: "org-g", Visibility: "private"},
				"beta/web":      &y.Repository,
			},
			byID: map[string]*RepositoryRef{"x": x, "y": y},
			orgs: map[string]string{"gamma": "org-g", "beta": "org-b"},
		}
	}

	cases := []struct {
		name      string
		org, repo string
		want      string // "" for no redirect
		wantCalls []string
	}{
		// Organization redirect first: the old slug is swapped for the current
		// one and the repository looked up there before any repository redirect.
		{"old org slug, repository exists there", "acme", "nginx", "gamma/nginx", []string{"repo:gamma/nginx"}},
		// Then the repository redirect under the requested (old) slug.
		{"old org slug and old repo name", "acme", "alpine", "gamma/alpine2", []string{"repo:gamma/alpine", "id:x"}},
		// Old repository name under the current org slug: found through the
		// organization's former slugs.
		{"current org slug, old repo name", "gamma", "alpine", "gamma/alpine2", []string{"org:gamma", "id:x"}},
		// A transferred repository keeps answering under its old home.
		{"transferred repository", "acme", "web", "beta/web", []string{"repo:gamma/web", "id:y"}},
		{"unknown org", "nobody", "alpine", "", []string{"org:nobody"}},
		{"unknown repo in known org", "beta", "alpine", "", []string{"org:beta"}},
		{"nothing matches under old slug", "acme", "missing", "", []string{"repo:gamma/missing"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			db := newLookup()
			got, err := ResolveMoved(ctx, table, db, c.org, c.repo)
			if err != nil {
				t.Fatalf("ResolveMoved: %v", err)
			}
			path := ""
			if got != nil {
				path = got.Path()
			}
			if path != c.want {
				t.Fatalf("ResolveMoved(%s/%s) = %q, want %q", c.org, c.repo, path, c.want)
			}
			if len(db.calls) != len(c.wantCalls) {
				t.Fatalf("lookup calls = %v, want %v", db.calls, c.wantCalls)
			}
			for i := range c.wantCalls {
				if db.calls[i] != c.wantCalls[i] {
					t.Fatalf("lookup calls = %v, want %v", db.calls, c.wantCalls)
				}
			}
		})
	}
}

func TestResolveMovedEmptyTable(t *testing.T) {
	db := &fakeLookup{}
	got, err := ResolveMoved(context.Background(), NewRedirectTable(nil, nil), db, "acme", "alpine")
	if err != nil || got != nil {
		t.Fatalf("empty table: got %v, %v", got, err)
	}
	if len(db.calls) != 0 {
		t.Fatalf("empty table must not touch the database, got %v", db.calls)
	}
	var nilTable *RedirectTable
	if got, err := ResolveMoved(context.Background(), nilTable, db, "acme", "alpine"); err != nil || got != nil {
		t.Fatalf("nil table: got %v, %v", got, err)
	}
}

func TestResolveMovedStaleTarget(t *testing.T) {
	// A redirect whose target row is gone is skipped, not an error.
	table := NewRedirectTable(nil, []RepoRedirect{{OrgSlug: "acme", Name: "gone", RepositoryID: "zzz"}})
	db := &fakeLookup{orgs: map[string]string{"acme": "org-a"}}
	got, err := ResolveMoved(context.Background(), table, db, "acme", "gone")
	if err != nil || got != nil {
		t.Fatalf("stale target: got %v, %v", got, err)
	}
}

// TestEnsureRepositoryClearsRedirects runs against a real database (see
// TestTagRuleChecks): a repository created with a former name takes it over,
// so the redirect for that name — under the current or a former slug of the
// organization — disappears.
func TestEnsureRepositoryClearsRedirects(t *testing.T) {
	url := os.Getenv("REGISTRYD_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("REGISTRYD_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s, err := New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer s.Close()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	orgID := "test-org-" + suffix
	slug := "redir-" + suffix
	oldSlug := "old-" + suffix
	if _, err := s.pool.Exec(ctx, `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, orgID, slug, slug); err != nil {
		t.Fatalf("insert organization: %v", err)
	}
	defer s.pool.Exec(context.Background(), `DELETE FROM organization WHERE id = $1`, orgID)
	if _, err := s.pool.Exec(ctx, `INSERT INTO organization_redirects (old_slug, organization_id) VALUES ($1, $2)`, oldSlug, orgID); err != nil {
		t.Fatalf("insert organization redirect: %v", err)
	}
	defer s.pool.Exec(context.Background(), `DELETE FROM organization_redirects WHERE old_slug = $1`, oldSlug)

	target, err := s.EnsureRepository(ctx, slug, "target", "private")
	if err != nil {
		t.Fatalf("create target: %v", err)
	}
	// "app" used to be the target's name, under both the current and a former slug; "keep" is unrelated.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO repository_redirects (organization_slug, repository_name, repository_id)
		VALUES ($1, 'app', $3), ($2, 'app', $3), ($1, 'keep', $3)`, slug, oldSlug, target.ID); err != nil {
		t.Fatalf("insert redirects: %v", err)
	}

	table, err := s.LoadRedirects(ctx)
	if err != nil {
		t.Fatalf("LoadRedirects: %v", err)
	}
	if o, ok := table.Org(oldSlug); !ok || o.Slug != slug || o.OrgID != orgID {
		t.Fatalf("org redirect not loaded: %+v %v", o, ok)
	}
	moved, err := ResolveMoved(ctx, table, s, oldSlug, "app")
	if err != nil || moved == nil || moved.ID != target.ID || moved.Path() != slug+"/target" {
		t.Fatalf("ResolveMoved(%s/app) = %+v, %v", oldSlug, moved, err)
	}

	created, err := s.EnsureRepository(ctx, slug, "app", "private")
	if err != nil {
		t.Fatalf("create app: %v", err)
	}
	if created.ID == target.ID {
		t.Fatal("expected a new repository")
	}
	var remaining []string
	rows, err := s.pool.Query(ctx, `SELECT organization_slug || '/' || repository_name FROM repository_redirects WHERE repository_id = $1 ORDER BY 1`, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var p string
		_ = rows.Scan(&p)
		remaining = append(remaining, p)
	}
	rows.Close()
	if len(remaining) != 1 || remaining[0] != slug+"/keep" {
		t.Fatalf("redirects after taking the name over = %v, want only %s/keep", remaining, slug)
	}
	if repo, err := s.GetRepository(ctx, slug, "app"); err != nil || repo.ID != created.ID {
		t.Fatalf("new repository must be served directly: %+v %v", repo, err)
	}
}
