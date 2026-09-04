package ratelimit

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestParseLimit(t *testing.T) {
	good := map[string]Limit{
		"":          {},
		"  ":        {},
		"100/6h":    {Count: 100, Window: 6 * time.Hour},
		"3/1m":      {Count: 3, Window: time.Minute},
		" 10 / 30s": {Count: 10, Window: 30 * time.Second},
		"5000/1d":   {Count: 5000, Window: 24 * time.Hour},
	}
	for in, want := range good {
		got, err := ParseLimit(in)
		if err != nil {
			t.Errorf("ParseLimit(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ParseLimit(%q) = %+v, want %+v", in, got, want)
		}
	}
	for _, bad := range []string{"100", "100/", "/6h", "0/6h", "100/0h", "100/6x", "abc/6h", "-1/6h", "100/6h extra"} {
		if _, err := ParseLimit(bad); err == nil {
			t.Errorf("ParseLimit(%q): expected error", bad)
		}
	}
	if s := (Limit{Count: 100, Window: 6 * time.Hour}).String(); s != "100/6h" {
		t.Errorf("String() = %q", s)
	}
	if s := (Limit{Count: 7, Window: 90 * time.Second}).String(); s != "7/90s" {
		t.Errorf("String() = %q", s)
	}
	if s := (Limit{Count: 1, Window: 48 * time.Hour}).String(); s != "1/2d" {
		t.Errorf("String() = %q", s)
	}
}

func TestParseCIDRs(t *testing.T) {
	got, err := ParseCIDRs("10.0.0.0/8, 192.168.1.5\n fd00::/8;172.16.0.1/32")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"10.0.0.0/8", "192.168.1.5/32", "fd00::/8", "172.16.0.1/32"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Errorf("prefix %d = %s, want %s", i, got[i], want[i])
		}
	}
	if _, err := ParseCIDRs("10.0.0.0/8, nope"); err == nil {
		t.Error("expected an error for an invalid entry")
	}
	if got, _ := ParseCIDRs(""); len(got) != 0 {
		t.Errorf("empty list parsed to %v", got)
	}
}

func TestConfigFromSettings(t *testing.T) {
	defaults := Settings{Anonymous: "100/6h", Authenticated: "200/6h", TrustedProxies: "10.0.0.0/8"}
	// No row: environment defaults apply.
	cfg, err := ConfigFromSettings(nil, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Anonymous.Count != 100 || cfg.Authenticated.Count != 200 || len(cfg.TrustedProxies) != 1 {
		t.Errorf("defaults not applied: %+v", cfg)
	}
	// A stored row wins field by field; an empty string disables the limit.
	cfg, err = ConfigFromSettings([]byte(`{"anonymous":"3/1m","authenticated":""}`), defaults)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Anonymous != (Limit{Count: 3, Window: time.Minute}) {
		t.Errorf("anonymous = %+v", cfg.Anonymous)
	}
	if !cfg.Authenticated.IsZero() {
		t.Errorf("authenticated should be unlimited, got %+v", cfg.Authenticated)
	}
	if len(cfg.TrustedProxies) != 1 {
		t.Errorf("trusted proxies should fall back to the environment, got %v", cfg.TrustedProxies)
	}
	if _, err := ConfigFromSettings([]byte(`{"anonymous":"lots"}`), defaults); err == nil {
		t.Error("expected an error for an unparsable stored limit")
	}
	if _, err := ConfigFromSettings([]byte(`not json`), defaults); err == nil {
		t.Error("expected an error for invalid JSON")
	}
}

func TestLimiterWindow(t *testing.T) {
	l := NewLimiter(Limit{Count: 3, Window: time.Minute})
	t0 := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)

	for i := 1; i <= 3; i++ {
		d := l.Take("a", t0.Add(time.Duration(i)*time.Second))
		if !d.Allowed {
			t.Fatalf("request %d should be allowed", i)
		}
		if d.Remaining != int64(3-i) {
			t.Errorf("request %d remaining = %d, want %d", i, d.Remaining, 3-i)
		}
		if !d.Reset.Equal(t0.Add(time.Second + time.Minute)) {
			t.Errorf("request %d reset = %s, want %s", i, d.Reset, t0.Add(time.Second+time.Minute))
		}
	}
	d := l.Take("a", t0.Add(4*time.Second))
	if d.Allowed || d.Remaining != 0 {
		t.Fatalf("4th request: allowed=%v remaining=%d", d.Allowed, d.Remaining)
	}
	if ra := d.RetryAfter(t0.Add(4 * time.Second)); ra != 57 {
		t.Errorf("RetryAfter = %d, want 57", ra)
	}
	// A different key has its own budget.
	if d := l.Take("b", t0.Add(4*time.Second)); !d.Allowed || d.Remaining != 2 {
		t.Errorf("other key: allowed=%v remaining=%d", d.Allowed, d.Remaining)
	}
	// After the window, the first key recovers with a fresh window.
	d = l.Take("a", t0.Add(62*time.Second))
	if !d.Allowed || d.Remaining != 2 {
		t.Errorf("after window: allowed=%v remaining=%d", d.Allowed, d.Remaining)
	}
	if !d.Reset.Equal(t0.Add(62*time.Second + time.Minute)) {
		t.Errorf("new window reset = %s", d.Reset)
	}
	// A later request triggers the periodic sweep, which drops "b" (its
	// window ended at t0+64s) while keeping the live "a" window.
	l.Take("c", t0.Add(125*time.Second))
	l.mu.Lock()
	_, hasA := l.entries["a"]
	_, hasB := l.entries["b"]
	l.mu.Unlock()
	if hasB {
		t.Error("expired entry was not swept")
	}
	if hasA {
		t.Error("a's window (t0+62s) had also expired by t0+125s and should be gone")
	}
}

func TestManager(t *testing.T) {
	cfg, _ := ConfigFromSettings(nil, Settings{Anonymous: "2/1m"})
	m := NewManager(cfg)
	now := time.Now()
	if _, err := m.Take(context.Background(), false, "user:1", now); err != ErrUnlimited {
		t.Errorf("authenticated should be unlimited, got %v", err)
	}
	if d, err := m.Take(context.Background(), true, "1.2.3.4", now); err != nil || !d.Allowed || d.Remaining != 1 {
		t.Errorf("first anonymous take: %+v %v", d, err)
	}
	if changed := m.Reload(cfg); changed {
		t.Error("reloading the same config reported a change")
	}
	// Same config object semantics: the budget survived the no-op reload.
	if d, _ := m.Take(context.Background(), true, "1.2.3.4", now); !d.Allowed || d.Remaining != 0 {
		t.Errorf("second anonymous take: %+v", d)
	}
	next, _ := ConfigFromSettings(nil, Settings{Anonymous: "5/1h", Authenticated: "1/1h"})
	if changed := m.Reload(next); !changed {
		t.Error("changed config not detected")
	}
	if d, _ := m.Take(context.Background(), true, "1.2.3.4", now); !d.Allowed || d.Remaining != 4 {
		t.Errorf("after reload the counter should restart: %+v", d)
	}
	if d, err := m.Take(context.Background(), false, "user:1", now); err != nil || !d.Allowed || d.Remaining != 0 {
		t.Errorf("authenticated after reload: %+v %v", d, err)
	}
}

func TestClientIP(t *testing.T) {
	trusted, _ := ParseCIDRs("10.0.0.0/8, ::1")
	cases := []struct {
		remote, xff string
		want        string
	}{
		{"203.0.113.9:51234", "", "203.0.113.9"},
		{"203.0.113.9:51234", "198.51.100.7", "203.0.113.9"}, // untrusted peer: header ignored
		{"10.1.2.3:443", "198.51.100.7", "198.51.100.7"},
		{"10.1.2.3:443", "198.51.100.7, 192.0.2.1", "192.0.2.1"}, // last hop only
		{"10.1.2.3:443", " 192.0.2.1 ", "192.0.2.1"},
		{"10.1.2.3:443", "garbage", "10.1.2.3"},
		{"[::1]:8080", "2001:db8::5", "2001:db8::5"},
		{"[::ffff:10.0.0.1]:1", "192.0.2.9", "192.0.2.9"}, // v4-mapped peer matches the v4 prefix
		{"[2001:db8::1]:1", "192.0.2.9", "2001:db8::1"},
		{"not-an-address", "192.0.2.9", "not-an-address"},
	}
	for _, c := range cases {
		if got := ClientIP(c.remote, c.xff, trusted); got != c.want {
			t.Errorf("ClientIP(%q, %q) = %q, want %q", c.remote, c.xff, got, c.want)
		}
	}
}

// fakeCounter is a shared counter kept in a map: one budget, like Postgres.
type fakeCounter struct {
	counts map[string]int64
	starts map[string]time.Time
	err    error
	calls  int
}

func newFakeCounter() *fakeCounter {
	return &fakeCounter{counts: map[string]int64{}, starts: map[string]time.Time{}}
}

func (f *fakeCounter) TakeRateLimit(_ context.Context, key string, windowStart time.Time) (int64, error) {
	f.calls++
	if f.err != nil {
		return 0, f.err
	}
	if start, ok := f.starts[key]; !ok || start.Before(windowStart) {
		f.starts[key] = windowStart
		f.counts[key] = 0
	}
	f.counts[key]++
	return f.counts[key], nil
}

func TestSharedManagerCountsOneBudget(t *testing.T) {
	counter := newFakeCounter()
	cfg := Config{Anonymous: Limit{Count: 3, Window: time.Minute}}
	// Two managers stand in for two replicas sharing the counter.
	a := NewSharedManager(cfg, counter)
	b := NewSharedManager(cfg, counter)
	if !a.Shared() {
		t.Fatal("expected shared counters")
	}
	now := time.Date(2026, 1, 2, 3, 4, 30, 0, time.UTC)
	for i, m := range []*Manager{a, b, a} {
		d, err := m.Take(context.Background(), true, "ip:203.0.113.7", now)
		if err != nil || !d.Allowed {
			t.Fatalf("request %d: allowed=%v err=%v", i+1, d.Allowed, err)
		}
		if want := int64(2 - i); d.Remaining != want {
			t.Fatalf("request %d: remaining %d, want %d", i+1, d.Remaining, want)
		}
	}
	d, err := b.Take(context.Background(), true, "ip:203.0.113.7", now)
	if err != nil {
		t.Fatalf("fourth request: %v", err)
	}
	if d.Allowed {
		t.Fatal("fourth request across replicas should be refused")
	}
	if d.Remaining != 0 {
		t.Fatalf("remaining %d, want 0", d.Remaining)
	}
	// Windows are aligned, so both replicas agree when the budget resets.
	if want := now.Truncate(time.Minute).Add(time.Minute); !d.Reset.Equal(want) {
		t.Fatalf("reset %v, want %v", d.Reset, want)
	}
	next, err := a.Take(context.Background(), true, "ip:203.0.113.7", now.Add(time.Minute))
	if err != nil || !next.Allowed {
		t.Fatalf("next window: allowed=%v err=%v", next.Allowed, err)
	}
}

func TestSharedManagerSeparatesClasses(t *testing.T) {
	counter := newFakeCounter()
	cfg := Config{Anonymous: Limit{Count: 1, Window: time.Minute}, Authenticated: Limit{Count: 1, Window: time.Minute}}
	m := NewSharedManager(cfg, counter)
	now := time.Now()
	if d, _ := m.Take(context.Background(), true, "same", now); !d.Allowed {
		t.Fatal("anonymous request refused")
	}
	// The same key in the other class must draw from its own budget.
	if d, _ := m.Take(context.Background(), false, "same", now); !d.Allowed {
		t.Fatal("authenticated request drew from the anonymous budget")
	}
}

func TestSharedManagerReportsCounterErrors(t *testing.T) {
	counter := newFakeCounter()
	counter.err = errors.New("connection refused")
	m := NewSharedManager(Config{Anonymous: Limit{Count: 1, Window: time.Minute}}, counter)
	if _, err := m.Take(context.Background(), true, "ip:1.2.3.4", time.Now()); err == nil {
		t.Fatal("expected the counter error to reach the caller (it fails open there)")
	}
}

func TestManagerWithoutCounterStaysInProcess(t *testing.T) {
	m := NewManager(Config{Anonymous: Limit{Count: 1, Window: time.Minute}})
	if m.Shared() {
		t.Fatal("NewManager must not report shared counters")
	}
	if d, err := m.Take(context.Background(), true, "ip:1.2.3.4", time.Now()); err != nil || !d.Allowed {
		t.Fatalf("allowed=%v err=%v", d.Allowed, err)
	}
}
