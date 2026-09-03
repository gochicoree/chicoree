package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestMatchTagGlob(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		// literals
		{"latest", "latest", true},
		{"latest", "Latest", false}, // case-sensitive
		{"latest", "latest2", false},
		{"latest", "atest", false},
		{"", "", true},
		{"", "x", false},
		// star
		{"*", "", true},
		{"*", "anything", true},
		{"v*", "v1.2.3", true},
		{"v*", "v", true},
		{"v*", "1.2.3", false},
		{"release-*", "release-2024.01", true},
		{"release-*", "release", false},
		{"*-rc", "1.0-rc", true},
		{"*-rc", "1.0-rc1", false},
		{"*.*", "1.2", true},
		{"*.*", "12", false},
		{"**", "abc", true},
		{"a*b*c", "abc", true},
		{"a*b*c", "aXXbYYc", true},
		{"a*b*c", "aXXbYY", false},
		{"a*b*c", "abcabc", true}, // backtracking past the first "b"
		// question mark
		{"v?", "v1", true},
		{"v?", "v10", false},
		{"v?.?", "v1.2", true},
		{"v?.?", "v1.23", false},
		{"?", "", false},
		{"v?*", "v1", true},
		{"v?*", "v", false},
		// dots and dashes are literal, never wildcards
		{"1.27.*", "1.27.4", true},
		{"1.27.*", "1x27x4", false},
		{"sha-*", "sha-abc123", true},
	}
	for _, c := range cases {
		if got := MatchTagGlob(c.pattern, c.name); got != c.want {
			t.Errorf("MatchTagGlob(%q, %q) = %v, want %v", c.pattern, c.name, got, c.want)
		}
	}
}

func TestPolicyErrorIsError(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &PolicyError{Message: "tag v1 is immutable"})
	if !IsPolicyError(err) {
		t.Fatal("wrapped PolicyError not recognised")
	}
	if IsPolicyError(errors.New("other")) {
		t.Fatal("plain error reported as PolicyError")
	}
	if IsPolicyError(&QuotaError{Scope: "organization", Kind: "storage"}) {
		t.Fatal("QuotaError reported as PolicyError")
	}
}

// TestTagRuleChecks exercises the store-level checks against a real database
// with the web app's schema applied. It runs only when
// REGISTRYD_TEST_DATABASE_URL is set (e.g. a scratch database created with
// `drizzle-kit push`), and cleans up the rows it creates.
func TestTagRuleChecks(t *testing.T) {
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
	slug := "tagrules-" + suffix
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, orgID, slug, slug); err != nil {
		t.Fatalf("insert organization: %v", err)
	}
	// Everything below cascades from the organization row.
	defer s.pool.Exec(context.Background(), `DELETE FROM organization WHERE id = $1`, orgID)

	repo, err := s.EnsureRepository(ctx, slug, "app", "private")
	if err != nil {
		t.Fatalf("create repository: %v", err)
	}
	digestA := "sha256:" + fmt.Sprintf("%064d", 1)
	digestB := "sha256:" + fmt.Sprintf("%064d", 2)
	for _, d := range []string{digestA, digestB} {
		m := &Manifest{RepositoryID: repo.ID, Digest: d, MediaType: "application/vnd.oci.image.manifest.v1+json", Size: 2, Payload: []byte("{}")}
		if err := s.UpsertManifest(ctx, m, nil); err != nil {
			t.Fatalf("upsert manifest: %v", err)
		}
	}
	if err := s.UpsertTag(ctx, repo.ID, "v1", digestA); err != nil {
		t.Fatalf("upsert tag: %v", err)
	}
	if err := s.UpsertTag(ctx, repo.ID, "latest", digestA); err != nil {
		t.Fatalf("upsert tag: %v", err)
	}
	if err := s.UpsertTag(ctx, repo.ID, "dev", digestB); err != nil {
		t.Fatalf("upsert tag: %v", err)
	}

	// No rules: everything is allowed.
	if err := s.CheckTagImmutable(ctx, repo, "v1", digestB); err != nil {
		t.Fatalf("without rules, re-pointing v1 must be allowed: %v", err)
	}
	if err := s.CheckManifestDeletable(ctx, repo, digestA); err != nil {
		t.Fatalf("without rules, deleting by digest must be allowed: %v", err)
	}

	// Organization-wide immutable rule for v*, repository protected rule for latest.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO tag_rules (organization_id, repository_id, pattern, immutable, protected)
		VALUES ($1, NULL, 'v*', true, false), ($1, $2, 'latest', false, true)`, orgID, repo.ID); err != nil {
		t.Fatalf("insert rules: %v", err)
	}
	rules, err := s.TagRulesFor(ctx, orgID, repo.ID)
	if err != nil || len(rules) != 2 {
		t.Fatalf("TagRulesFor = %v, %v; want 2 rules", rules, err)
	}
	if rules[0].Pattern != "latest" || rules[0].RepositoryID != repo.ID {
		t.Fatalf("repository rules must come first, got %+v", rules)
	}

	// Immutable: a different digest is refused, the same digest and new tags pass.
	if err := s.CheckTagImmutable(ctx, repo, "v1", digestB); !IsPolicyError(err) {
		t.Fatalf("re-pointing immutable v1: got %v, want PolicyError", err)
	} else if err.Error() != `tag v1 is immutable (rule "v*"): it already points at sha256:000000000000 and cannot be re-pointed` {
		t.Fatalf("unexpected message: %s", err.Error())
	}
	if err := s.CheckTagImmutable(ctx, repo, "v1", digestA); err != nil {
		t.Fatalf("same digest must pass: %v", err)
	}
	if err := s.CheckTagImmutable(ctx, repo, "v2", digestB); err != nil {
		t.Fatalf("new tag must pass: %v", err)
	}
	if err := s.CheckTagImmutable(ctx, repo, "dev", digestA); err != nil {
		t.Fatalf("unmatched tag must pass: %v", err)
	}
	// The guarded upsert refuses too, and leaves the tag untouched.
	if err := s.UpsertTagGuarded(ctx, repo, "v1", digestB); !IsPolicyError(err) {
		t.Fatalf("UpsertTagGuarded on immutable v1: got %v, want PolicyError", err)
	}
	if d, _ := s.ResolveTag(ctx, repo.ID, "v1"); d != digestA {
		t.Fatalf("v1 changed to %s", d)
	}
	if err := s.UpsertTagGuarded(ctx, repo, "dev", digestA); err != nil {
		t.Fatalf("UpsertTagGuarded on dev: %v", err)
	}
	if err := s.UpsertTagGuarded(ctx, repo, "v3", digestB); err != nil {
		t.Fatalf("UpsertTagGuarded on new v3: %v", err)
	}

	// Protected: the tag cannot go, nor the manifest it names; other tags can.
	if err := s.CheckTagDeletable(ctx, repo, "latest"); !IsPolicyError(err) {
		t.Fatalf("deleting protected latest: got %v, want PolicyError", err)
	}
	if err := s.CheckTagDeletable(ctx, repo, "v1"); err != nil {
		t.Fatalf("deleting v1 (immutable but not protected) must pass: %v", err)
	}
	if err := s.CheckManifestDeletable(ctx, repo, digestA); !IsPolicyError(err) {
		t.Fatalf("deleting the manifest behind latest: got %v, want PolicyError", err)
	}
	if err := s.CheckManifestDeletable(ctx, repo, digestB); err != nil {
		t.Fatalf("deleting the manifest behind v3 only must pass: %v", err)
	}
}
