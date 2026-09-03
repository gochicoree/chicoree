// Package traffic aggregates egress/ingress byte counts per repository and
// day in memory and flushes them to Postgres in batches, so the request path
// never waits on the database.
package traffic

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Delta is one request's contribution to a repository's daily counters.
type Delta struct {
	PullBytes     int64 // bytes served by registryd (blob and manifest GETs)
	PushBytes     int64 // bytes received (committed blob uploads, manifest PUTs)
	RedirectBytes int64 // blob size of GETs answered with a redirect to storage
	BlobPulls     int64
	ManifestPulls int64
}

func (d *Delta) add(o Delta) {
	d.PullBytes += o.PullBytes
	d.PushBytes += o.PushBytes
	d.RedirectBytes += o.RedirectBytes
	d.BlobPulls += o.BlobPulls
	d.ManifestPulls += o.ManifestPulls
}

// Row is one (repository, day) bucket handed to the sink.
type Row struct {
	RepositoryID string
	Day          string // YYYY-MM-DD in UTC
	Delta
}

// Sink persists a batch of rows (an UPSERT that adds the deltas).
type Sink func(ctx context.Context, rows []Row) error

type key struct {
	repo string
	day  string
}

// Counter is the in-memory aggregate. It is safe for concurrent use.
type Counter struct {
	sink Sink
	now  func() time.Time

	mu      sync.Mutex
	pending map[key]*Delta
}

// New returns a counter that flushes through sink.
func New(sink Sink) *Counter {
	return &Counter{sink: sink, now: time.Now, pending: map[key]*Delta{}}
}

// Add records a delta for the repository under today's (UTC) bucket. Rows
// are keyed by the day the bytes moved, so a flush that straddles midnight
// writes to both days instead of misattributing the earlier traffic.
func (c *Counter) Add(repoID string, d Delta) {
	if c == nil || repoID == "" || d == (Delta{}) {
		return
	}
	k := key{repo: repoID, day: c.now().UTC().Format("2006-01-02")}
	c.mu.Lock()
	cur := c.pending[k]
	if cur == nil {
		cur = &Delta{}
		c.pending[k] = cur
	}
	cur.add(d)
	c.mu.Unlock()
}

// Pending returns the number of buckets waiting to be flushed.
func (c *Counter) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// Flush hands everything aggregated so far to the sink. On failure the rows
// are merged back so nothing is lost; the next flush retries.
func (c *Counter) Flush(ctx context.Context) error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	if len(c.pending) == 0 {
		c.mu.Unlock()
		return nil
	}
	batch := c.pending
	c.pending = map[key]*Delta{}
	c.mu.Unlock()

	rows := make([]Row, 0, len(batch))
	for k, d := range batch {
		rows = append(rows, Row{RepositoryID: k.repo, Day: k.day, Delta: *d})
	}
	if err := c.sink(ctx, rows); err != nil {
		c.mu.Lock()
		for k, d := range batch {
			cur := c.pending[k]
			if cur == nil {
				c.pending[k] = d
				continue
			}
			cur.add(*d)
		}
		c.mu.Unlock()
		return err
	}
	return nil
}

// Run flushes every interval until ctx is done, then flushes one last time
// with a short grace period so a shutdown does not drop the tail.
func (c *Counter) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			final, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.Flush(final); err != nil {
				slog.Warn("traffic: final flush failed", "err", err)
			}
			cancel()
			return
		case <-ticker.C:
			if err := c.Flush(ctx); err != nil {
				slog.Warn("traffic: flush failed", "err", err)
			}
		}
	}
}
