package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"testing"

	"registryd/internal/storage"
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

// A storage backend that cannot answer must turn the health check red.
type failingDriver struct{ storage.Driver }

func (failingDriver) Stat(context.Context, string) (int64, error) {
	return 0, errors.New("bucket unreachable")
}
func (failingDriver) Name() string { return "failing" }

type absentDriver struct{ storage.Driver }

func (absentDriver) Stat(context.Context, string) (int64, error) { return 0, storage.ErrNotFound }
func (absentDriver) Name() string                                { return "absent" }

func TestHealthzReflectsStorage(t *testing.T) {
	for _, c := range []struct {
		name   string
		driver storage.Driver
		want   int
	}{
		{"backend answers not-found", absentDriver{}, 200},
		{"backend errors", failingDriver{}, 503},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := &Server{driver: c.driver}
			w := httptest.NewRecorder()
			s.handleHealthz(w, httptest.NewRequest("GET", "/internal/v1/healthz", nil))
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d (body %s)", w.Code, c.want, w.Body.String())
			}
			var body struct {
				Status string            `json:"status"`
				Checks map[string]string `json:"checks"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if (body.Status == "ok") != (c.want == 200) {
				t.Fatalf("status field %q for code %d", body.Status, w.Code)
			}
			if _, ok := body.Checks["storage"]; !ok {
				t.Fatalf("no storage check in %v", body.Checks)
			}
		})
	}
}
