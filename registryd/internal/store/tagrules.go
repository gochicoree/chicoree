package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// PolicyError is a tag-rule violation: an immutable tag being re-pointed, a
// protected tag being deleted, or a manifest deleted while a protected tag
// still names it. The API answers these with 403 DENIED and the message.
type PolicyError struct {
	Message string
}

func (e *PolicyError) Error() string { return e.Message }

// IsPolicyError reports whether err is a PolicyError.
func IsPolicyError(err error) bool {
	var pe *PolicyError
	return errors.As(err, &pe)
}

// TagRule mirrors a row of tag_rules (written by the web app).
type TagRule struct {
	Pattern   string
	Immutable bool
	Protected bool
	// RepositoryID is empty for organization-wide rules.
	RepositoryID string
}

// MatchTagGlob reports whether a tag name matches a rule pattern. `*`
// matches any run of characters (including none), `?` exactly one, and
// everything else is literal. Matching is case-sensitive, like tags.
func MatchTagGlob(pattern, name string) bool {
	p, n := 0, 0
	starP, starN := -1, 0
	for n < len(name) {
		switch {
		case p < len(pattern) && (pattern[p] == '?' || pattern[p] == name[n]):
			p++
			n++
		case p < len(pattern) && pattern[p] == '*':
			// Remember the star; try matching the rest with zero characters
			// first and backtrack one character at a time on failure.
			starP, starN = p, n
			p++
		case starP >= 0:
			p = starP + 1
			starN++
			n = starN
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// firstRule returns the first rule matching the tag for which want holds.
func firstRule(rules []TagRule, tag string, want func(TagRule) bool) *TagRule {
	for i := range rules {
		if want(rules[i]) && MatchTagGlob(rules[i].Pattern, tag) {
			return &rules[i]
		}
	}
	return nil
}

func immutableRule(rules []TagRule, tag string) *TagRule {
	return firstRule(rules, tag, func(r TagRule) bool { return r.Immutable })
}

func protectedRule(rules []TagRule, tag string) *TagRule {
	return firstRule(rules, tag, func(r TagRule) bool { return r.Protected })
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// TagRulesFor loads the rules that apply to a repository: its own plus the
// organization-wide ones (repository rules first).
func (s *Store) TagRulesFor(ctx context.Context, orgID, repoID string) ([]TagRule, error) {
	return tagRulesFor(ctx, s.pool, orgID, repoID)
}

func tagRulesFor(ctx context.Context, q querier, orgID, repoID string) ([]TagRule, error) {
	rows, err := q.Query(ctx, `
		SELECT pattern, immutable, protected, COALESCE(repository_id, '')
		FROM tag_rules
		WHERE organization_id = $1 AND (repository_id IS NULL OR repository_id = $2)
		ORDER BY repository_id NULLS LAST, pattern`, orgID, repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TagRule
	for rows.Next() {
		var r TagRule
		if err := rows.Scan(&r.Pattern, &r.Immutable, &r.Protected, &r.RepositoryID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func shortDigest(d string) string {
	if len(d) > 19 {
		return d[:19]
	}
	return d
}

func immutableViolation(tag, current string, rule *TagRule) error {
	return &PolicyError{Message: fmt.Sprintf(
		"tag %s is immutable (rule %q): it already points at %s and cannot be re-pointed",
		tag, rule.Pattern, shortDigest(current))}
}

// CheckTagImmutable fails with a *PolicyError when the tag already points at
// a different manifest and an immutable rule covers it. Pushing the same
// digest again, or a tag that does not exist yet, is always allowed.
func (s *Store) CheckTagImmutable(ctx context.Context, repo *Repository, tag, digest string) error {
	current, err := s.ResolveTag(ctx, repo.ID, tag)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if current == digest {
		return nil
	}
	rules, err := s.TagRulesFor(ctx, repo.OrgID, repo.ID)
	if err != nil {
		return err
	}
	if r := immutableRule(rules, tag); r != nil {
		return immutableViolation(tag, current, r)
	}
	return nil
}

// UpsertTagGuarded points the tag at the manifest like UpsertTag, but takes a
// row lock first and re-checks immutability inside the transaction, so two
// concurrent pushes cannot slip past CheckTagImmutable together.
func (s *Store) UpsertTagGuarded(ctx context.Context, repo *Repository, tag, digest string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var current string
	err = tx.QueryRow(ctx, `
		SELECT manifest_digest FROM tags WHERE repository_id = $1 AND name = $2 FOR UPDATE`,
		repo.ID, tag).Scan(&current)
	if err != nil && !isNoRows(err) {
		return err
	}
	if err == nil && current != digest {
		rules, err := tagRulesFor(ctx, tx, repo.OrgID, repo.ID)
		if err != nil {
			return err
		}
		if r := immutableRule(rules, tag); r != nil {
			return immutableViolation(tag, current, r)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tags (repository_id, name, manifest_digest)
		VALUES ($1, $2, $3)
		ON CONFLICT (repository_id, name) DO UPDATE
		SET manifest_digest = EXCLUDED.manifest_digest, updated_at = now()`,
		repo.ID, tag, digest); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CheckTagDeletable fails with a *PolicyError when a protected rule covers
// the tag.
func (s *Store) CheckTagDeletable(ctx context.Context, repo *Repository, tag string) error {
	rules, err := s.TagRulesFor(ctx, repo.OrgID, repo.ID)
	if err != nil {
		return err
	}
	if r := protectedRule(rules, tag); r != nil {
		return &PolicyError{Message: fmt.Sprintf("tag %s is protected (rule %q) and cannot be deleted", tag, r.Pattern)}
	}
	return nil
}

// CheckManifestDeletable fails with a *PolicyError when a protected tag
// points at the manifest: deleting it by digest would remove that tag too.
func (s *Store) CheckManifestDeletable(ctx context.Context, repo *Repository, digest string) error {
	tags, err := s.TagsForManifest(ctx, repo.ID, digest)
	if err != nil {
		return err
	}
	if len(tags) == 0 {
		return nil
	}
	rules, err := s.TagRulesFor(ctx, repo.OrgID, repo.ID)
	if err != nil {
		return err
	}
	for _, t := range tags {
		if r := protectedRule(rules, t); r != nil {
			return &PolicyError{Message: fmt.Sprintf(
				"manifest %s is tagged %s, which is protected (rule %q); the tag must be unprotected first",
				shortDigest(digest), t, r.Pattern)}
		}
	}
	return nil
}
