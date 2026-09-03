package upstream

import (
	"context"
	"sync"
	"time"
)

// Group deduplicates concurrent work by key: the first caller runs fn, every
// caller that arrives while it is in flight waits for the same result. Unlike
// x/sync/singleflight, waiting is bounded by the caller's context, and the
// leader runs on a detached context so one client hanging up does not abort
// a download other clients are waiting for.
type Group struct {
	mu    sync.Mutex
	calls map[string]*call
	// LeaderTimeout caps how long a detached leader may run (default 1h).
	LeaderTimeout time.Duration
}

type call struct {
	done chan struct{}
	val  any
	err  error
}

// Result of a Do call.
type Result struct {
	Val any
	Err error
	// Shared is true when the result came from another caller's execution.
	Shared bool
}

// Do runs fn for key unless a call is already in flight, in which case it
// waits for that call. ctx only bounds the wait; fn receives its own context.
func (g *Group) Do(ctx context.Context, key string, fn func(ctx context.Context) (any, error)) Result {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*call{}
	}
	if c, ok := g.calls[key]; ok {
		g.mu.Unlock()
		return wait(ctx, c, true)
	}
	c := &call{done: make(chan struct{})}
	g.calls[key] = c
	g.mu.Unlock()

	timeout := g.LeaderTimeout
	if timeout <= 0 {
		timeout = time.Hour
	}
	go func() {
		leaderCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				c.err = &panicError{value: r}
			}
			g.mu.Lock()
			delete(g.calls, key)
			g.mu.Unlock()
			close(c.done)
		}()
		c.val, c.err = fn(leaderCtx)
	}()
	return wait(ctx, c, false)
}

func wait(ctx context.Context, c *call, shared bool) Result {
	select {
	case <-c.done:
		return Result{Val: c.val, Err: c.err, Shared: shared}
	case <-ctx.Done():
		return Result{Err: ctx.Err(), Shared: shared}
	}
}

type panicError struct{ value any }

func (p *panicError) Error() string { return "download panicked" }
