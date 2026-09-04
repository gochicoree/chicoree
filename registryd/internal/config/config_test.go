package config

import (
	"testing"
	"time"
)

func TestDeriveInternalAPIURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://web:3000/api/internal/events":        "http://web:3000/api/internal",
		"http://localhost:3105/api/internal/events/": "http://localhost:3105/api/internal",
		"https://registry.example.com/x":             "https://registry.example.com",
		"http://web:3000":                            "http://web:3000",
		"":                                           "",
	} {
		if got := DeriveInternalAPIURL(in); got != want {
			t.Errorf("DeriveInternalAPIURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLoadSigningKeyDurations(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("TOKEN_REALM", "http://web/token")

	t.Setenv("TOKEN_KEY_RELOAD_INTERVAL", "")
	t.Setenv("TOKEN_KEY_DROP_WINDOW", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.KeyReloadInterval != time.Minute || c.KeyDropWindow != 10*time.Minute {
		t.Fatalf("defaults = %s / %s, want 1m / 10m", c.KeyReloadInterval, c.KeyDropWindow)
	}

	t.Setenv("TOKEN_KEY_RELOAD_INTERVAL", "30s")
	t.Setenv("TOKEN_KEY_DROP_WINDOW", "15m")
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.KeyReloadInterval != 30*time.Second || c.KeyDropWindow != 15*time.Minute {
		t.Fatalf("parsed = %s / %s, want 30s / 15m", c.KeyReloadInterval, c.KeyDropWindow)
	}

	// Garbage falls back to the defaults (envDuration semantics).
	t.Setenv("TOKEN_KEY_RELOAD_INTERVAL", "soon")
	t.Setenv("TOKEN_KEY_DROP_WINDOW", "later")
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.KeyReloadInterval != time.Minute || c.KeyDropWindow != 10*time.Minute {
		t.Fatalf("invalid values should fall back, got %s / %s", c.KeyReloadInterval, c.KeyDropWindow)
	}

	// Too small to be safe: refused.
	t.Setenv("TOKEN_KEY_RELOAD_INTERVAL", "1s")
	t.Setenv("TOKEN_KEY_DROP_WINDOW", "10m")
	if _, err := Load(); err == nil {
		t.Fatal("reload interval below 5s must be refused")
	}
	t.Setenv("TOKEN_KEY_RELOAD_INTERVAL", "60s")
	t.Setenv("TOKEN_KEY_DROP_WINDOW", "2m")
	if _, err := Load(); err == nil {
		t.Fatal("drop window below the token lifetime must be refused")
	}
}
