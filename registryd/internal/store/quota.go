package store

import (
	"context"
	"errors"
	"fmt"
)

// QuotaError describes a limit an admin configured that a push would exceed.
type QuotaError struct {
	Scope string // "organization" or "owner"
	Kind  string // "storage", "private repositories", "public repositories"
	Used  int64
	Limit int64
}

func (e *QuotaError) Error() string {
	if e.Kind == "storage" {
		return fmt.Sprintf("%s storage quota exceeded: %s of %s used", e.Scope, humanBytes(e.Used), humanBytes(e.Limit))
	}
	return fmt.Sprintf("%s quota exceeded: %d of %d %s used", e.Scope, e.Used, e.Limit, e.Kind)
}

// IsQuotaError reports whether err is a QuotaError.
func IsQuotaError(err error) bool {
	var qe *QuotaError
	return errors.As(err, &qe)
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// orgStorageUsed sums the distinct blobs linked to the organization's repos.
const orgStorageUsedSQL = `
	SELECT COALESCE(sum(size), 0)::bigint FROM (
		SELECT DISTINCT b.digest, b.size FROM blobs b
		JOIN repository_blobs rb ON rb.blob_digest = b.digest
		JOIN repositories r ON r.id = rb.repository_id
		WHERE r.organization_id = $1) t`

// ownerStorageUsedSQL sums usage across the organizations the user owns
// that have no storage limit of their own: an organization with its own
// limit is governed by that limit alone (see web/src/lib/quota.ts).
const ownerStorageUsedSQL = `
	SELECT COALESCE(sum(size), 0)::bigint FROM (
		SELECT DISTINCT r.organization_id, b.digest, b.size FROM blobs b
		JOIN repository_blobs rb ON rb.blob_digest = b.digest
		JOIN repositories r ON r.id = rb.repository_id
		JOIN member m ON m.organization_id = r.organization_id
		LEFT JOIN organization_limits ol ON ol.organization_id = r.organization_id
		WHERE m.user_id = $1 AND m.role = 'owner' AND ol.max_storage_bytes IS NULL) t`

// CheckStorageQuota fails with a *QuotaError when adding `additional` bytes
// to the organization would exceed the org's own limit or, when it has
// none, any owner's account limit.
func (s *Store) CheckStorageQuota(ctx context.Context, orgID string, additional int64) error {
	var limit *int64
	err := s.pool.QueryRow(ctx, `SELECT max_storage_bytes FROM organization_limits WHERE organization_id = $1`, orgID).Scan(&limit)
	if err != nil && !isNoRows(err) {
		return err
	}
	if limit != nil {
		var used int64
		if err := s.pool.QueryRow(ctx, orgStorageUsedSQL, orgID).Scan(&used); err != nil {
			return err
		}
		if used+additional > *limit {
			return &QuotaError{Scope: "organization", Kind: "storage", Used: used, Limit: *limit}
		}
		// The organization's own limit governs it; the owners' accounts are not consulted.
		return nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT ul.user_id, ul.max_storage_bytes FROM member m
		JOIN user_limits ul ON ul.user_id = m.user_id
		WHERE m.organization_id = $1 AND m.role = 'owner' AND ul.max_storage_bytes IS NOT NULL`, orgID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type owner struct {
		id    string
		limit int64
	}
	var owners []owner
	for rows.Next() {
		var o owner
		if err := rows.Scan(&o.id, &o.limit); err != nil {
			return err
		}
		owners = append(owners, o)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, o := range owners {
		var used int64
		if err := s.pool.QueryRow(ctx, ownerStorageUsedSQL, o.id).Scan(&used); err != nil {
			return err
		}
		if used+additional > o.limit {
			return &QuotaError{Scope: "owner", Kind: "storage", Used: used, Limit: o.limit}
		}
	}
	return nil
}

// CheckRepositoryQuota fails when the organization (or one of its owners)
// may not create another repository of the given visibility.
func (s *Store) CheckRepositoryQuota(ctx context.Context, orgID, visibility string) error {
	column := "max_private_repos"
	kind := "private repositories"
	if visibility == "public" {
		column = "max_public_repos"
		kind = "public repositories"
	}

	var limit *int64
	err := s.pool.QueryRow(ctx, `SELECT `+column+` FROM organization_limits WHERE organization_id = $1`, orgID).Scan(&limit)
	if err != nil && !isNoRows(err) {
		return err
	}
	if limit != nil {
		var used int64
		if err := s.pool.QueryRow(ctx, `
			SELECT count(*) FROM repositories WHERE organization_id = $1 AND visibility = $2`, orgID, visibility).Scan(&used); err != nil {
			return err
		}
		if used >= *limit {
			return &QuotaError{Scope: "organization", Kind: kind, Used: used, Limit: *limit}
		}
		// The organization's own limit governs it; the owners' accounts are not consulted.
		return nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT ul.user_id, ul.`+column+` FROM member m
		JOIN user_limits ul ON ul.user_id = m.user_id
		WHERE m.organization_id = $1 AND m.role = 'owner' AND ul.`+column+` IS NOT NULL`, orgID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type owner struct {
		id    string
		limit int64
	}
	var owners []owner
	for rows.Next() {
		var o owner
		if err := rows.Scan(&o.id, &o.limit); err != nil {
			return err
		}
		owners = append(owners, o)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, o := range owners {
		var used int64
		// Organizations with their own limit of this kind are outside the owner's pool.
		if err := s.pool.QueryRow(ctx, `
			SELECT count(*) FROM repositories r
			JOIN member m ON m.organization_id = r.organization_id
			LEFT JOIN organization_limits ol ON ol.organization_id = r.organization_id
			WHERE m.user_id = $1 AND m.role = 'owner' AND r.visibility = $2 AND ol.`+column+` IS NULL`, o.id, visibility).Scan(&used); err != nil {
			return err
		}
		if used >= o.limit {
			return &QuotaError{Scope: "owner", Kind: kind, Used: used, Limit: o.limit}
		}
	}
	return nil
}

// OrgHasBlob reports whether the blob is already linked to any repository of
// the organization (and therefore already counted against its storage).
func (s *Store) OrgHasBlob(ctx context.Context, orgID, digest string) (bool, error) {
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM repository_blobs rb JOIN repositories r ON r.id = rb.repository_id
		WHERE r.organization_id = $1 AND rb.blob_digest = $2 LIMIT 1`, orgID, digest).Scan(&one)
	if isNoRows(err) {
		return false, nil
	}
	return err == nil, err
}
