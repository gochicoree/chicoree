// Package store is registryd's view of the shared Postgres database. The web
// application owns the schema (via drizzle migrations); this package only
// reads and writes rows. Table and column names here must stay in sync with
// web/src/db/schema.ts.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// Store wraps a pgx connection pool.
type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// WaitForSchema blocks until the web app's migrations have created the domain
// tables (compose starts both services concurrently).
func (s *Store) WaitForSchema(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var one int
		err := s.pool.QueryRow(ctx, `SELECT 1 FROM information_schema.tables WHERE table_name = 'repositories'`).Scan(&one)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("schema not ready after %s (run the web app migrations first)", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// Repository is the subset of repository metadata the registry needs.
type Repository struct {
	ID         string
	OrgID      string
	Visibility string // "public" or "private"
}

// GetRepository looks a repository up by org slug and repo name.
func (s *Store) GetRepository(ctx context.Context, orgSlug, name string) (*Repository, error) {
	r := &Repository{}
	err := s.pool.QueryRow(ctx, `
		SELECT r.id, r.organization_id, r.visibility
		FROM repositories r
		JOIN organization o ON o.id = r.organization_id
		WHERE o.slug = $1 AND r.name = $2`, orgSlug, name).
		Scan(&r.ID, &r.OrgID, &r.Visibility)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

// OrgIDBySlug resolves an organization id from its slug.
func (s *Store) OrgIDBySlug(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id FROM organization WHERE slug = $1`, slug).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

// DefaultVisibility resolves the visibility for a repository auto-created by
// a push: the organization's setting wins, then the pushing user's setting,
// then private.
func (s *Store) DefaultVisibility(ctx context.Context, orgID, actorType, actorID string) (string, error) {
	var v *string
	err := s.pool.QueryRow(ctx, `SELECT default_visibility FROM organization_settings WHERE organization_id = $1`, orgID).Scan(&v)
	if err != nil && !isNoRows(err) {
		return "", err
	}
	if v != nil && *v != "" {
		return *v, nil
	}
	if actorType == "user" && actorID != "" {
		err := s.pool.QueryRow(ctx, `SELECT default_visibility FROM user_settings WHERE user_id = $1`, actorID).Scan(&v)
		if err != nil && !isNoRows(err) {
			return "", err
		}
		if v != nil && *v != "" {
			return *v, nil
		}
	}
	return "private", nil
}

// EnsureRepository returns the repository, creating it with the given
// visibility on first push if the organization exists. Quotas must have been
// checked by the caller.
func (s *Store) EnsureRepository(ctx context.Context, orgSlug, name, visibility string) (*Repository, error) {
	repo, err := s.GetRepository(ctx, orgSlug, name)
	if err == nil {
		return repo, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	orgID, err := s.OrgIDBySlug(ctx, orgSlug)
	if err != nil {
		return nil, err // unknown org: never auto-create organizations
	}
	if visibility != "public" {
		visibility = "private"
	}
	r := &Repository{OrgID: orgID}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		INSERT INTO repositories (organization_id, name, visibility)
		VALUES ($1, $2, $3)
		ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = now()
		RETURNING id, visibility`, orgID, name, visibility).
		Scan(&r.ID, &r.Visibility)
	if err != nil {
		return nil, err
	}
	// A new repository takes over its name: any redirect that still pointed
	// the name (under this slug or a former slug of the organization) at a
	// renamed or transferred repository is dropped (see redirects.go).
	if _, err := tx.Exec(ctx, `
		DELETE FROM repository_redirects rr
		WHERE rr.repository_name = $2
		  AND (rr.organization_slug = $1
		       OR rr.organization_slug IN (SELECT old_slug FROM organization_redirects WHERE organization_id = $3))`,
		orgSlug, name, orgID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

// BlobManifestRefs counts manifests in the repository that still reference
// the blob (as config, layer, or child manifest).
func (s *Store) BlobManifestRefs(ctx context.Context, repoID, digest string) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM manifest_refs WHERE repository_id = $1 AND ref_digest = $2`, repoID, digest).Scan(&n)
	return n, err
}

func (s *Store) TouchRepository(ctx context.Context, repoID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE repositories SET updated_at = now() WHERE id = $1`, repoID)
	return err
}

func (s *Store) IncrementPullCount(ctx context.Context, repoID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE repositories SET pull_count = pull_count + 1 WHERE id = $1`, repoID)
	return err
}

// --- Blobs ---

// UpsertBlob records a blob and links it to the repository in one round trip.
func (s *Store) UpsertBlob(ctx context.Context, repoID, digest string, size int64, mediaType string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO blobs (digest, size, media_type) VALUES ($1, $2, NULLIF($3, ''))
		ON CONFLICT (digest) DO NOTHING`, digest, size, mediaType); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO repository_blobs (repository_id, blob_digest) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, repoID, digest); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LinkBlob links an existing blob to a repository (cross-repo mount).
func (s *Store) LinkBlob(ctx context.Context, repoID, digest string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO repository_blobs (repository_id, blob_digest) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, repoID, digest)
	return err
}

// LinkedBlobSize returns the blob size if the blob is linked to the repo.
func (s *Store) LinkedBlobSize(ctx context.Context, repoID, digest string) (int64, error) {
	var size int64
	err := s.pool.QueryRow(ctx, `
		SELECT b.size FROM repository_blobs rb
		JOIN blobs b ON b.digest = rb.blob_digest
		WHERE rb.repository_id = $1 AND rb.blob_digest = $2`, repoID, digest).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return size, err
}

// BlobExists reports whether the blob is known to any repository.
func (s *Store) BlobExists(ctx context.Context, digest string) (int64, bool, error) {
	var size int64
	err := s.pool.QueryRow(ctx, `SELECT size FROM blobs WHERE digest = $1`, digest).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return size, true, nil
}

// UnlinkBlob removes the repo link and reports how many links remain overall.
func (s *Store) UnlinkBlob(ctx context.Context, repoID, digest string) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		DELETE FROM repository_blobs WHERE repository_id = $1 AND blob_digest = $2`, repoID, digest)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, ErrNotFound
	}
	var remaining int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM repository_blobs WHERE blob_digest = $1`, digest).Scan(&remaining); err != nil {
		return 0, err
	}
	if remaining == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM blobs WHERE digest = $1`, digest); err != nil {
			return 0, err
		}
	}
	return remaining, tx.Commit(ctx)
}

// --- Manifests ---

// Manifest mirrors a row in the manifests table.
type Manifest struct {
	RepositoryID  string
	Digest        string
	MediaType     string
	ArtifactType  string
	Size          int64
	Payload       []byte
	ConfigDigest  string
	SubjectDigest string
	PushedBy      string
}

// UpsertManifest stores the manifest and its outgoing references.
func (s *Store) UpsertManifest(ctx context.Context, m *Manifest, refs []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO manifests (repository_id, digest, media_type, artifact_type, size, payload, config_digest, subject_digest, pushed_by)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''))
		ON CONFLICT (repository_id, digest) DO UPDATE
		SET media_type = EXCLUDED.media_type, artifact_type = EXCLUDED.artifact_type,
		    subject_digest = EXCLUDED.subject_digest, pushed_by = EXCLUDED.pushed_by`,
		m.RepositoryID, m.Digest, m.MediaType, m.ArtifactType, m.Size, string(m.Payload),
		m.ConfigDigest, m.SubjectDigest, m.PushedBy); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM manifest_refs WHERE repository_id = $1 AND manifest_digest = $2`,
		m.RepositoryID, m.Digest); err != nil {
		return err
	}
	for _, ref := range refs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO manifest_refs (repository_id, manifest_digest, ref_digest)
			VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			m.RepositoryID, m.Digest, ref); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// GetManifest fetches a manifest by digest within a repository.
func (s *Store) GetManifest(ctx context.Context, repoID, digest string) (*Manifest, error) {
	m := &Manifest{RepositoryID: repoID, Digest: digest}
	var payload string
	var artifactType, configDigest, subjectDigest, pushedBy *string
	err := s.pool.QueryRow(ctx, `
		SELECT media_type, artifact_type, size, payload, config_digest, subject_digest, pushed_by
		FROM manifests WHERE repository_id = $1 AND digest = $2`, repoID, digest).
		Scan(&m.MediaType, &artifactType, &m.Size, &payload, &configDigest, &subjectDigest, &pushedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.Payload = []byte(payload)
	if artifactType != nil {
		m.ArtifactType = *artifactType
	}
	if configDigest != nil {
		m.ConfigDigest = *configDigest
	}
	if subjectDigest != nil {
		m.SubjectDigest = *subjectDigest
	}
	if pushedBy != nil {
		m.PushedBy = *pushedBy
	}
	return m, nil
}

// ManifestExists checks for a manifest row without loading the payload.
func (s *Store) ManifestExists(ctx context.Context, repoID, digest string) (bool, error) {
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM manifests WHERE repository_id = $1 AND digest = $2`, repoID, digest).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// DeleteManifest removes a manifest (tags and refs cascade via FKs).
// ManifestBlockRow is one manifest_blocks row: why a manifest may not be
// pulled and whether callers with push rights on the repository are exempt
// (signature-policy blocks: the pusher must read the image to sign it).
type ManifestBlockRow struct {
	Reason        string
	PushersExempt bool
}

// ManifestBlock reports whether one of the web app's pull policies
// (vulnerability threshold, required signatures) forbids pulling a manifest
// (manifest_blocks is written by the web app only).
func (s *Store) ManifestBlock(ctx context.Context, repoID, digest string) (*ManifestBlockRow, error) {
	var row ManifestBlockRow
	err := s.pool.QueryRow(ctx, `
		SELECT reason, pushers_exempt FROM manifest_blocks WHERE repository_id = $1 AND digest = $2`, repoID, digest).
		Scan(&row.Reason, &row.PushersExempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *Store) DeleteManifest(ctx context.Context, repoID, digest string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM manifests WHERE repository_id = $1 AND digest = $2`, repoID, digest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Referrer is a descriptor row for the referrers API.
type Referrer struct {
	Digest       string
	MediaType    string
	ArtifactType string
	Size         int64
	// Annotations of the referring manifest; the spec requires them in the
	// response and clients (cosign) use them to tell signatures from
	// attestations without fetching every manifest.
	Annotations map[string]string
}

// ListReferrers returns manifests in the repo whose subject is the digest.
func (s *Store) ListReferrers(ctx context.Context, repoID, subject, artifactType string) ([]Referrer, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT digest, media_type, COALESCE(artifact_type, ''), size, (payload::jsonb)->'annotations'
		FROM manifests
		WHERE repository_id = $1 AND subject_digest = $2
		  AND ($3 = '' OR artifact_type = $3)
		ORDER BY created_at`, repoID, subject, artifactType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Referrer
	for rows.Next() {
		var r Referrer
		var annotations []byte
		if err := rows.Scan(&r.Digest, &r.MediaType, &r.ArtifactType, &r.Size, &annotations); err != nil {
			return nil, err
		}
		r.Annotations = ParseAnnotations(annotations)
		out = append(out, r)
	}
	return out, rows.Err()
}

// ParseAnnotations decodes a manifest's annotations object; anything that
// is not a JSON object of strings yields nil (annotations are optional).
func ParseAnnotations(raw []byte) map[string]string {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil || len(m) == 0 {
		return nil
	}
	return m
}

// --- Tags ---

func (s *Store) UpsertTag(ctx context.Context, repoID, name, manifestDigest string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tags (repository_id, name, manifest_digest)
		VALUES ($1, $2, $3)
		ON CONFLICT (repository_id, name) DO UPDATE
		SET manifest_digest = EXCLUDED.manifest_digest, updated_at = now()`,
		repoID, name, manifestDigest)
	return err
}

func (s *Store) ResolveTag(ctx context.Context, repoID, name string) (string, error) {
	var digest string
	err := s.pool.QueryRow(ctx, `
		SELECT manifest_digest FROM tags WHERE repository_id = $1 AND name = $2`,
		repoID, name).Scan(&digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return digest, err
}

func (s *Store) DeleteTag(ctx context.Context, repoID, name string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM tags WHERE repository_id = $1 AND name = $2`, repoID, name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// TagsForManifest returns the names of every tag pointing at the digest.
func (s *Store) TagsForManifest(ctx context.Context, repoID, digest string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT name FROM tags WHERE repository_id = $1 AND manifest_digest = $2 ORDER BY name`, repoID, digest)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// ListTags returns tag names sorted lexically, after `last`, limited to n.
func (s *Store) ListTags(ctx context.Context, repoID string, n int, last string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT name FROM tags WHERE repository_id = $1 AND name > $2
		ORDER BY name LIMIT $3`, repoID, last, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// Catalog lists repositories as "org/name", sorted, after `last`, limited to n.
func (s *Store) Catalog(ctx context.Context, n int, last string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.slug || '/' || r.name AS path
		FROM repositories r JOIN organization o ON o.id = r.organization_id
		WHERE o.slug || '/' || r.name > $1
		ORDER BY path LIMIT $2`, last, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- Events ---

// Event captures a registry action for the activity feed and statistics.
type Event struct {
	RepositoryID   string
	Type           string // push | pull | delete
	ActorType      string // user | sa | anonymous
	ActorID        string
	ManifestDigest string
	Tag            string
}

func (s *Store) RecordEvent(ctx context.Context, e *Event) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO events (repository_id, type, actor_type, actor_id, manifest_digest, tag)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''))`,
		e.RepositoryID, e.Type, e.ActorType, e.ActorID, e.ManifestDigest, e.Tag)
	return err
}

// --- Garbage collection ---

// GCResult summarizes a garbage collection pass.
type GCResult struct {
	UnlinkedBlobs   int64 `json:"unlinkedBlobs"`
	DeletedBlobs    int64 `json:"deletedBlobs"`
	OrphanedDigests []string
	SweptUploads    int `json:"sweptUploads"`
}

// CollectGarbage unlinks blobs no manifest references anymore and returns the
// digests whose content should be removed from backend storage. A grace window
// protects blobs uploaded moments ago whose manifest has not arrived yet.
func (s *Store) CollectGarbage(ctx context.Context, grace time.Duration) (*GCResult, error) {
	res := &GCResult{}
	cutoff := time.Now().Add(-grace)

	// 1. Drop repo links that no manifest in that repo references.
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM repository_blobs rb
		WHERE rb.created_at < $1
		  AND NOT EXISTS (
			SELECT 1 FROM manifest_refs mr
			WHERE mr.repository_id = rb.repository_id AND mr.ref_digest = rb.blob_digest)`, cutoff)
	if err != nil {
		return nil, err
	}
	res.UnlinkedBlobs = tag.RowsAffected()

	// 2. Collect and delete blob rows with no remaining links anywhere.
	rows, err := s.pool.Query(ctx, `
		DELETE FROM blobs b
		WHERE b.created_at < $1
		  AND NOT EXISTS (SELECT 1 FROM repository_blobs rb WHERE rb.blob_digest = b.digest)
		RETURNING b.digest`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		res.OrphanedDigests = append(res.OrphanedDigests, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	res.DeletedBlobs = int64(len(res.OrphanedDigests))
	return res, nil
}

// BlobStats reports how many unique blobs exist and their total physical
// size, for the status endpoint.
func (s *Store) BlobStats(ctx context.Context) (count int64, bytes int64, err error) {
	err = s.pool.QueryRow(ctx, `SELECT count(*), COALESCE(sum(size), 0) FROM blobs`).Scan(&count, &bytes)
	return count, bytes, err
}
