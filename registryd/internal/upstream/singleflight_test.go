package upstream

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGroupDeduplicates(t *testing.T) {
	var g Group
	var calls atomic.Int32
	release := make(chan struct{})
	fn := func(ctx context.Context) (any, error) {
		calls.Add(1)
		<-release
		return "layer", nil
	}

	const n = 5
	results := make([]Result, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = g.Do(context.Background(), "sha256:abc", fn)
		}(i)
	}
	// Let every goroutine register before the leader finishes.
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 1 {
		t.Fatalf("fn ran %d times, want 1", got)
	}
	shared := 0
	for _, r := range results {
		if r.Err != nil || r.Val != "layer" {
			t.Fatalf("result = %+v", r)
		}
		if r.Shared {
			shared++
		}
	}
	if shared != n-1 {
		t.Fatalf("%d shared results, want %d", shared, n-1)
	}

	// After completion the key is free again: a new call runs fn again.
	r := g.Do(context.Background(), "sha256:abc", func(ctx context.Context) (any, error) {
		calls.Add(1)
		return "again", nil
	})
	if r.Val != "again" || calls.Load() != 2 {
		t.Fatalf("second round: %+v calls=%d", r, calls.Load())
	}
}

func TestGroupWaiterCancel(t *testing.T) {
	var g Group
	release := make(chan struct{})
	go g.Do(context.Background(), "k", func(ctx context.Context) (any, error) {
		<-release
		return nil, nil
	})
	time.Sleep(10 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	r := g.Do(ctx, "k", func(ctx context.Context) (any, error) { return "never", nil })
	if !errors.Is(r.Err, context.DeadlineExceeded) {
		t.Fatalf("waiter err = %v, want deadline", r.Err)
	}
	close(release)
}

func TestGroupLeaderDetached(t *testing.T) {
	var g Group
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	done := make(chan Result, 1)
	go func() {
		done <- g.Do(ctx, "k", func(leader context.Context) (any, error) {
			close(started)
			select {
			case <-leader.Done():
				return nil, leader.Err()
			case <-time.After(50 * time.Millisecond):
				return "finished", nil
			}
		})
	}()
	<-started
	cancel() // the first caller hangs up; the download must still complete
	r := <-done
	if !errors.Is(r.Err, context.Canceled) {
		t.Fatalf("cancelled caller got %+v", r)
	}
	second := g.Do(context.Background(), "k", func(context.Context) (any, error) { return "new", nil })
	if second.Val != "finished" || !second.Shared {
		t.Fatalf("late joiner got %+v, want the detached leader's result", second)
	}
}
