package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestTakeRateLimit exercises the shared counter against a real database
// when REGISTRYD_TEST_DATABASE_URL is set, and cleans up after itself.
func TestTakeRateLimit(t *testing.T) {
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

	key := "test|" + time.Now().Format("150405.000000")
	window := time.Now().Truncate(time.Minute)
	defer func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM rate_limit_counters WHERE key = $1`, key)
	}()

	for want := int64(1); want <= 3; want++ {
		got, err := s.TakeRateLimit(ctx, key, window)
		if err != nil {
			t.Fatalf("take %d: %v", want, err)
		}
		if got != want {
			t.Fatalf("take %d returned %d", want, got)
		}
	}
	// A later window resets the counter rather than accumulating.
	got, err := s.TakeRateLimit(ctx, key, window.Add(time.Minute))
	if err != nil {
		t.Fatalf("next window: %v", err)
	}
	if got != 1 {
		t.Fatalf("next window returned %d, want 1", got)
	}
	// A stale window (a replica whose clock lags) must not reopen the budget.
	got, err = s.TakeRateLimit(ctx, key, window)
	if err != nil {
		t.Fatalf("stale window: %v", err)
	}
	if got != 2 {
		t.Fatalf("stale window returned %d, want 2", got)
	}
	if _, err := s.SweepRateLimits(ctx, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var rows int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM rate_limit_counters WHERE key = $1`, key).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 0 {
		t.Fatalf("sweep left %d rows", rows)
	}
}
