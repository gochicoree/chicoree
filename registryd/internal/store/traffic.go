package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"registryd/internal/traffic"
)

// --- Traffic accounting (repository_traffic) ---

// UpsertTraffic adds the batched deltas to their (repository, day) rows in
// one pipelined round trip. Rows of repositories deleted since the traffic
// was counted are skipped rather than failing the batch.
func (s *Store) UpsertTraffic(ctx context.Context, rows []traffic.Row) error {
	if len(rows) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(`
			INSERT INTO repository_traffic (repository_id, day, pull_bytes, push_bytes, redirect_bytes, blob_pulls, manifest_pulls)
			SELECT $1, $2::date, $3, $4, $5, $6, $7
			WHERE EXISTS (SELECT 1 FROM repositories WHERE id = $1)
			ON CONFLICT (repository_id, day) DO UPDATE SET
				pull_bytes     = repository_traffic.pull_bytes + EXCLUDED.pull_bytes,
				push_bytes     = repository_traffic.push_bytes + EXCLUDED.push_bytes,
				redirect_bytes = repository_traffic.redirect_bytes + EXCLUDED.redirect_bytes,
				blob_pulls     = repository_traffic.blob_pulls + EXCLUDED.blob_pulls,
				manifest_pulls = repository_traffic.manifest_pulls + EXCLUDED.manifest_pulls`,
			r.RepositoryID, r.Day, r.PullBytes, r.PushBytes, r.RedirectBytes, r.BlobPulls, r.ManifestPulls)
	}
	res := s.pool.SendBatch(ctx, batch)
	defer res.Close()
	for range rows {
		if _, err := res.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// --- Instance settings (written by the web app) ---

// InstanceSetting returns the raw JSON value of one instance_settings row,
// or ErrNotFound when the section has never been saved.
func (s *Store) InstanceSetting(ctx context.Context, key string) (json.RawMessage, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT value FROM instance_settings WHERE key = $1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
