package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"registryd/internal/storage"
)

// Shared upload staging (STORAGE_STAGING=shared) keeps its sessions in
// upload_sessions; this file implements storage.SessionStore. Chunk bytes
// live in the storage backend — the row only records their keys and sizes.

func (s *Store) CreateUploadSession(ctx context.Context, id, org, repo, node string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO upload_sessions (id, organization, repository, node, expires_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5)`, id, org, repo, node, expiresAt)
	return err
}

func (s *Store) GetUploadSession(ctx context.Context, id string) (*storage.UploadSessionRow, error) {
	row := &storage.UploadSessionRow{ID: id}
	err := s.pool.QueryRow(ctx, `
		SELECT organization, repository, "offset", chunks FROM upload_sessions WHERE id = $1`, id).
		Scan(&row.Org, &row.Repo, &row.Offset, &row.Chunks)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// AppendUploadChunk is the optimistic lock that serialises appends across
// replicas: the update only applies while the stored offset is still the
// one the caller saw.
func (s *Store) AppendUploadChunk(ctx context.Context, id string, expected int64, chunk storage.UploadChunk, expiresAt time.Time) (int64, bool, error) {
	entry, err := json.Marshal([]storage.UploadChunk{chunk})
	if err != nil {
		return 0, false, err
	}
	var offset int64
	err = s.pool.QueryRow(ctx, `
		UPDATE upload_sessions
		SET "offset" = "offset" + $3, chunks = chunks || $4::jsonb, updated_at = now(), expires_at = $5
		WHERE id = $1 AND "offset" = $2
		RETURNING "offset"`, id, expected, chunk.Size, string(entry), expiresAt).Scan(&offset)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return offset, true, nil
}

func (s *Store) DeleteUploadSession(ctx context.Context, id string) (*storage.UploadSessionRow, error) {
	row := &storage.UploadSessionRow{ID: id}
	err := s.pool.QueryRow(ctx, `
		DELETE FROM upload_sessions WHERE id = $1
		RETURNING organization, repository, "offset", chunks`, id).
		Scan(&row.Org, &row.Repo, &row.Offset, &row.Chunks)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

func (s *Store) DeleteExpiredUploadSessions(ctx context.Context) ([]storage.UploadSessionRow, error) {
	rows, err := s.pool.Query(ctx, `
		DELETE FROM upload_sessions WHERE expires_at < now()
		RETURNING id, organization, repository, "offset", chunks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storage.UploadSessionRow
	for rows.Next() {
		var row storage.UploadSessionRow
		if err := rows.Scan(&row.ID, &row.Org, &row.Repo, &row.Offset, &row.Chunks); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Store) ListUploadSessionIDs(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM upload_sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// UploadSessionCount reports how many shared upload sessions are in flight
// (for the status endpoint).
func (s *Store) UploadSessionCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM upload_sessions`).Scan(&n)
	return n, err
}
