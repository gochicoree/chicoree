package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Redirects: when a repository is renamed or transferred, or an organization
// slug changes, the web app records the former name in repository_redirects /
// organization_redirects. registryd resolves unknown names through these
// tables so pulls of the old reference keep working (see internal/api/redirects.go).

// OrgRedirect maps a former organization slug to the organization.
type OrgRedirect struct {
	OldSlug string
	OrgID   string
	// Slug is the organization's current slug.
	Slug string
}

// RepoRedirect maps a former <org>/<name> to a repository.
type RepoRedirect struct {
	OrgSlug      string // former organization slug
	Name         string // former repository name
	RepositoryID string
}

// RepositoryRef is a repository together with its current name.
type RepositoryRef struct {
	Repository
	OrgSlug string
	Name    string
}

// Path is the current "<org>/<name>" of the repository.
func (r *RepositoryRef) Path() string { return r.OrgSlug + "/" + r.Name }

// RedirectTable is an in-memory snapshot of both redirect tables; they are
// tiny, so the API layer loads them whole and caches the result briefly.
type RedirectTable struct {
	orgs     map[string]OrgRedirect  // by old slug
	repos    map[string]RepoRedirect // by "old-slug/old-name"
	oldSlugs map[string][]string     // organization id → former slugs
}

// NewRedirectTable builds a snapshot from rows (used by tests and LoadRedirects).
func NewRedirectTable(orgs []OrgRedirect, repos []RepoRedirect) *RedirectTable {
	t := &RedirectTable{
		orgs:     make(map[string]OrgRedirect, len(orgs)),
		repos:    make(map[string]RepoRedirect, len(repos)),
		oldSlugs: map[string][]string{},
	}
	for _, o := range orgs {
		t.orgs[o.OldSlug] = o
		t.oldSlugs[o.OrgID] = append(t.oldSlugs[o.OrgID], o.OldSlug)
	}
	for _, r := range repos {
		t.repos[r.OrgSlug+"/"+r.Name] = r
	}
	return t
}

// Empty reports whether no redirect exists at all (the common case).
func (t *RedirectTable) Empty() bool { return t == nil || (len(t.orgs) == 0 && len(t.repos) == 0) }

// Org returns the redirect for a former organization slug.
func (t *RedirectTable) Org(oldSlug string) (OrgRedirect, bool) {
	if t == nil {
		return OrgRedirect{}, false
	}
	o, ok := t.orgs[oldSlug]
	return o, ok
}

// Repo returns the redirect for a former <org>/<name>.
func (t *RedirectTable) Repo(orgSlug, name string) (RepoRedirect, bool) {
	if t == nil {
		return RepoRedirect{}, false
	}
	r, ok := t.repos[orgSlug+"/"+name]
	return r, ok
}

// OldSlugs lists the former slugs of an organization.
func (t *RedirectTable) OldSlugs(orgID string) []string {
	if t == nil {
		return nil
	}
	return t.oldSlugs[orgID]
}

// LoadRedirects reads both tables. Rows whose target vanished are skipped
// (the foreign keys cascade, so that only happens mid-transaction).
func (s *Store) LoadRedirects(ctx context.Context) (*RedirectTable, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.old_slug, r.organization_id, o.slug
		FROM organization_redirects r JOIN organization o ON o.id = r.organization_id`)
	if err != nil {
		return nil, err
	}
	var orgs []OrgRedirect
	for rows.Next() {
		var o OrgRedirect
		if err := rows.Scan(&o.OldSlug, &o.OrgID, &o.Slug); err != nil {
			rows.Close()
			return nil, err
		}
		orgs = append(orgs, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT rr.organization_slug, rr.repository_name, rr.repository_id
		FROM repository_redirects rr JOIN repositories r ON r.id = rr.repository_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var repos []RepoRedirect
	for rows.Next() {
		var r RepoRedirect
		if err := rows.Scan(&r.OrgSlug, &r.Name, &r.RepositoryID); err != nil {
			return nil, err
		}
		repos = append(repos, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return NewRedirectTable(orgs, repos), nil
}

// GetRepositoryByID loads a repository with its current organization slug
// and name (the redirect target is addressed by id, so a later rename of the
// target is followed transparently).
func (s *Store) GetRepositoryByID(ctx context.Context, id string) (*RepositoryRef, error) {
	r := &RepositoryRef{}
	err := s.pool.QueryRow(ctx, `
		SELECT r.id, r.organization_id, r.visibility, o.slug, r.name
		FROM repositories r JOIN organization o ON o.id = r.organization_id
		WHERE r.id = $1`, id).
		Scan(&r.ID, &r.OrgID, &r.Visibility, &r.OrgSlug, &r.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

// RepoLookup is what redirect resolution needs from the database; *Store
// implements it and tests substitute a fake.
type RepoLookup interface {
	GetRepository(ctx context.Context, orgSlug, name string) (*Repository, error)
	GetRepositoryByID(ctx context.Context, id string) (*RepositoryRef, error)
	OrgIDBySlug(ctx context.Context, slug string) (string, error)
}

// ResolveMoved finds where a name that does not exist (anymore) now lives.
// Order: the organization redirect first — a former org slug is replaced by
// the current one and the repository looked up there — then the repository
// redirects, under the requested slug, the current slug and every former
// slug of the organization. nil, nil means "no redirect".
func ResolveMoved(ctx context.Context, t *RedirectTable, db RepoLookup, orgSlug, name string) (*RepositoryRef, error) {
	if t.Empty() {
		return nil, nil
	}
	slugs := []string{orgSlug}
	var orgID string
	if o, ok := t.Org(orgSlug); ok {
		repo, err := db.GetRepository(ctx, o.Slug, name)
		if err == nil {
			return &RepositoryRef{Repository: *repo, OrgSlug: o.Slug, Name: name}, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		orgID = o.OrgID
		slugs = append(slugs, o.Slug)
	} else {
		id, err := db.OrgIDBySlug(ctx, orgSlug)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		orgID = id
	}
	if orgID != "" {
		slugs = append(slugs, t.OldSlugs(orgID)...)
	}
	for _, slug := range slugs {
		r, ok := t.Repo(slug, name)
		if !ok {
			continue
		}
		ref, err := db.GetRepositoryByID(ctx, r.RepositoryID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return ref, nil
	}
	return nil, nil
}
