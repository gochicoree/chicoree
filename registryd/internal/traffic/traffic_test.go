package traffic

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"
)

func TestAggregateAndFlush(t *testing.T) {
	var got []Row
	c := New(func(_ context.Context, rows []Row) error {
		got = append(got, rows...)
		return nil
	})
	at := time.Date(2026, 9, 3, 23, 59, 50, 0, time.UTC)
	c.now = func() time.Time { return at }

	c.Add("r1", Delta{PullBytes: 100, BlobPulls: 1})
	c.Add("r1", Delta{PullBytes: 50, ManifestPulls: 1})
	c.Add("r2", Delta{PushBytes: 7})
	c.Add("", Delta{PullBytes: 1}) // ignored: no repository
	c.Add("r3", Delta{})           // ignored: empty delta

	// Day rollover: the next request lands in a new bucket for r1.
	at = at.Add(20 * time.Second)
	c.Add("r1", Delta{RedirectBytes: 999, BlobPulls: 1})

	if c.Pending() != 3 {
		t.Fatalf("pending buckets = %d, want 3", c.Pending())
	}
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Pending() != 0 {
		t.Fatalf("pending after flush = %d", c.Pending())
	}
	sort.Slice(got, func(i, j int) bool {
		if got[i].RepositoryID != got[j].RepositoryID {
			return got[i].RepositoryID < got[j].RepositoryID
		}
		return got[i].Day < got[j].Day
	})
	want := []Row{
		{RepositoryID: "r1", Day: "2026-09-03", Delta: Delta{PullBytes: 150, BlobPulls: 1, ManifestPulls: 1}},
		{RepositoryID: "r1", Day: "2026-09-04", Delta: Delta{RedirectBytes: 999, BlobPulls: 1}},
		{RepositoryID: "r2", Day: "2026-09-03", Delta: Delta{PushBytes: 7}},
	}
	if len(got) != len(want) {
		t.Fatalf("rows = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	// Nothing pending: the sink is not called.
	calls := len(got)
	_ = c.Flush(context.Background())
	if len(got) != calls {
		t.Error("flush with nothing pending called the sink")
	}
}

func TestFlushFailureKeepsCounts(t *testing.T) {
	fail := true
	var got []Row
	c := New(func(_ context.Context, rows []Row) error {
		if fail {
			return errors.New("db down")
		}
		got = append(got, rows...)
		return nil
	})
	c.now = func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) }
	c.Add("r1", Delta{PullBytes: 10})
	if err := c.Flush(context.Background()); err == nil {
		t.Fatal("expected flush error")
	}
	// New traffic arriving between the failed flush and the retry is merged.
	c.Add("r1", Delta{PullBytes: 5})
	fail = false
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].PullBytes != 15 {
		t.Fatalf("rows after retry = %+v, want one row with 15 pull bytes", got)
	}
}

func TestRunFlushesOnShutdown(t *testing.T) {
	done := make(chan []Row, 1)
	c := New(func(_ context.Context, rows []Row) error {
		done <- rows
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	c.Add("r1", Delta{ManifestPulls: 1})
	go c.Run(ctx, time.Hour)
	cancel()
	select {
	case rows := <-done:
		if len(rows) != 1 || rows[0].ManifestPulls != 1 {
			t.Fatalf("final flush rows = %+v", rows)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no flush on shutdown")
	}
}
