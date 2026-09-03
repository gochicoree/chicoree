package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Proxy-cache bookkeeping. The proxy configuration itself (upstream URL,
// credentials, allow-list, TTL) reaches registryd through the web app's
// internal API — see internal/api/proxy.go — because credentials are
// encrypted with the web app's key. This file only touches the columns the
// registry maintains: organization_proxies.last_checked_at / last_error and
// tags.proxy_checked_at / last_pulled_at.

// ProxyTagState returns the digest a tag points at and when the proxy last
// confirmed it against the upstream (nil when never).
func (s *Store) ProxyTagState(ctx context.Context, repoID, name string) (string, *time.Time, error) {
	var digest string
	var checked *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT manifest_digest, proxy_checked_at FROM tags WHERE repository_id = $1 AND name = $2`,
		repoID, name).Scan(&digest, &checked)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return digest, checked, err
}

// UpsertProxyTag points a tag at a manifest fetched from the upstream and
// marks it as just checked.
func (s *Store) UpsertProxyTag(ctx context.Context, repoID, name, manifestDigest string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tags (repository_id, name, manifest_digest, proxy_checked_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (repository_id, name) DO UPDATE
		SET manifest_digest = EXCLUDED.manifest_digest, updated_at = now(), proxy_checked_at = now()`,
		repoID, name, manifestDigest)
	return err
}

// TouchProxyTag records that the upstream still serves the same digest.
func (s *Store) TouchProxyTag(ctx context.Context, repoID, name string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE tags SET proxy_checked_at = now() WHERE repository_id = $1 AND name = $2`, repoID, name)
	return err
}

// TouchTagPulled records the last pull of a tag (eviction uses it).
func (s *Store) TouchTagPulled(ctx context.Context, repoID, name string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE tags SET last_pulled_at = now() WHERE repository_id = $1 AND name = $2`, repoID, name)
	return err
}

// SetProxyStatus stores the outcome of the latest upstream contact.
func (s *Store) SetProxyStatus(ctx context.Context, orgID, lastError string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE organization_proxies SET last_checked_at = now(), last_error = NULLIF($2, '')
		WHERE organization_id = $1`, orgID, lastError)
	return err
}

// RegisterBlob records a blob's existence without linking it to a repository
// (the proxy downloader calls it once per digest; every requesting repository
// links afterwards). Unlinked rows are reclaimed by GC after the grace period.
func (s *Store) RegisterBlob(ctx context.Context, digest string, size int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO blobs (digest, size) VALUES ($1, $2) ON CONFLICT (digest) DO NOTHING`, digest, size)
	return err
}

// IsManifestReference reports whether any manifest in the repository refers
// to the digest (as config, layer or child) — the proxy only fetches blobs a
// cached manifest actually needs.
func (s *Store) IsManifestReference(ctx context.Context, repoID, digest string) (bool, error) {
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM manifest_refs WHERE repository_id = $1 AND ref_digest = $2 LIMIT 1`, repoID, digest).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// IsProxyOrganization reports whether the organization has a proxy row at
// all (enabled or not); used as a fallback when the config cache is cold.
func (s *Store) IsProxyOrganization(ctx context.Context, slug string) (bool, error) {
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM organization_proxies p JOIN organization o ON o.id = p.organization_id
		WHERE o.slug = $1`, slug).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
