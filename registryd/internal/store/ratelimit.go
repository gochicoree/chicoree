package store

import (
	"context"
	"time"
)

// TakeRateLimit adds one request to the counter for key in the window that
// starts at windowStart and returns the resulting count. One statement, so
// concurrent requests on any replica are serialised by the row lock: the
// count is exact across the whole deployment. A window that has moved on
// resets the row instead of accumulating.
//
// The counter keeps rising after the limit is reached; the caller compares
// the returned count with the limit, and the row disappears with the next
// sweep.
func (s *Store) TakeRateLimit(ctx context.Context, key string, windowStart time.Time) (int64, error) {
	var count int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO rate_limit_counters AS c (key, window_start, count)
		VALUES ($1, $2, 1)
		ON CONFLICT (key) DO UPDATE
		SET count = CASE WHEN c.window_start < EXCLUDED.window_start THEN 1 ELSE c.count + 1 END,
		    window_start = GREATEST(c.window_start, EXCLUDED.window_start)
		RETURNING count`, key, windowStart.UTC()).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// SweepRateLimits drops counters whose window ended before cutoff.
func (s *Store) SweepRateLimits(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM rate_limit_counters WHERE window_start < $1`, cutoff.UTC())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
