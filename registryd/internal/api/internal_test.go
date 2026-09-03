package api

import (
	"net/http/httptest"
	"os"
	"testing"
)

func TestInternalAuthorized(t *testing.T) {
	cases := []struct {
		name   string
		header string
		secret string
		want   bool
	}{
		{"exact match", "Bearer s3cret", "s3cret", true},
		{"wrong token", "Bearer nope", "s3cret", false},
		{"missing header", "", "s3cret", false},
		{"wrong scheme", "Basic s3cret", "s3cret", false},
		{"no secret configured", "Bearer ", "", false},
		{"empty token with secret", "Bearer ", "s3cret", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/internal/v1/status", nil)
			if c.header != "" {
				r.Header.Set("Authorization", c.header)
			}
			if got := internalAuthorized(r, c.secret); got != c.want {
				t.Fatalf("internalAuthorized = %v, want %v", got, c.want)
			}
		})
	}
}

func TestDiskFreeBytes(t *testing.T) {
	dir := t.TempDir()
	if n := diskFreeBytes(dir); n < 0 {
		t.Skipf("statfs unavailable on this platform (%d)", n)
	} else if n == 0 {
		t.Fatal("temp dir reports zero free bytes")
	}
	missing := dir + "/does-not-exist"
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("expected the probe path to be missing")
	}
	if n := diskFreeBytes(missing); n != -1 {
		t.Fatalf("missing path should yield -1, got %d", n)
	}
}
