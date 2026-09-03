package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"registryd/internal/storage"
	"registryd/internal/storage/filesystem"
)

func TestParseRange(t *testing.T) {
	const size = 100
	cases := []struct {
		header         string
		offset, length int64
		status         rangeStatus
	}{
		{"", 0, 0, rangeNone},
		{"bytes=0-9", 0, 10, rangeOK},
		{"bytes=5-", 5, 95, rangeOK},
		{"bytes=-10", 90, 10, rangeOK},
		{"bytes=-1000", 0, 100, rangeOK},   // suffix longer than the blob: whole blob
		{"bytes=90-1000", 90, 10, rangeOK}, // end clamped to the last byte
		{"bytes=99-99", 99, 1, rangeOK},
		{"bytes = 0 - 4", 0, 5, rangeOK},
		{"BYTES=0-0", 0, 1, rangeOK},
		{"bytes=100-", 0, 0, rangeUnsatisfiable},
		{"bytes=999999999-", 0, 0, rangeUnsatisfiable},
		{"bytes=200-300", 0, 0, rangeUnsatisfiable},
		{"bytes=-0", 0, 0, rangeUnsatisfiable},
		{"bytes=0-9,20-29", 0, 0, rangeNone}, // multi-range: ignored
		{"bytes=9-5", 0, 0, rangeNone},       // end before start: malformed, ignored
		{"bytes=abc", 0, 0, rangeNone},
		{"bytes=-", 0, 0, rangeNone},
		{"bytes=", 0, 0, rangeNone},
		{"items=0-9", 0, 0, rangeNone}, // unknown unit
		{"0-9", 0, 0, rangeNone},
	}
	for _, c := range cases {
		off, n, st := parseRange(c.header, size)
		if off != c.offset || n != c.length || st != c.status {
			t.Errorf("parseRange(%q) = (%d, %d, %d), want (%d, %d, %d)", c.header, off, n, st, c.offset, c.length, c.status)
		}
	}
	// Empty blob: every range is unsatisfiable, no header still serves it.
	if _, _, st := parseRange("bytes=0-", 0); st != rangeUnsatisfiable {
		t.Errorf("empty blob with range: %d", st)
	}
	if _, _, st := parseRange("bytes=-5", 0); st != rangeUnsatisfiable {
		t.Errorf("empty blob with suffix range: %d", st)
	}
	if _, _, st := parseRange("", 0); st != rangeNone {
		t.Errorf("empty blob without range: %d", st)
	}
}

// noRange hides the filesystem driver's OpenRange so the generic fallback is exercised.
type noRange struct{ d storage.Driver }

func (n noRange) Get(ctx context.Context, digest string) (io.ReadCloser, int64, error) {
	return n.d.Get(ctx, digest)
}
func (n noRange) Stat(ctx context.Context, digest string) (int64, error) {
	return n.d.Stat(ctx, digest)
}
func (n noRange) Put(ctx context.Context, digest string, r io.Reader, size int64) error {
	return n.d.Put(ctx, digest, r, size)
}
func (n noRange) Delete(ctx context.Context, digest string) error { return n.d.Delete(ctx, digest) }
func (n noRange) RedirectURL(ctx context.Context, digest string) (string, error) {
	return n.d.RedirectURL(ctx, digest)
}
func (n noRange) Name() string { return "norange" }

func TestWriteBlobContent(t *testing.T) {
	fsDriver, err := filesystem.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	content := []byte("0123456789abcdefghijklmnopqrstuvwxyz") // 36 bytes
	if err := fsDriver.Put(context.Background(), digest, bytes.NewReader(content), int64(len(content))); err != nil {
		t.Fatal(err)
	}
	size := int64(len(content))

	cases := []struct {
		name        string
		rangeHeader string
		wantStatus  int
		wantBody    string
		wantCR      string // Content-Range
		wantLen     string // Content-Length
		wantWritten int64
	}{
		{"full", "", 200, string(content), "", "36", 36},
		{"first ten", "bytes=0-9", 206, "0123456789", "bytes 0-9/36", "10", 10},
		{"open ended", "bytes=30-", 206, "uvwxyz", "bytes 30-35/36", "6", 6},
		{"suffix", "bytes=-3", 206, "xyz", "bytes 33-35/36", "3", 3},
		{"clamped", "bytes=34-100", 206, "yz", "bytes 34-35/36", "2", 2},
		{"multi ignored", "bytes=0-1,4-5", 200, string(content), "", "36", 36},
		{"unsatisfiable", "bytes=999999999-", 416, "", "bytes */36", "", 0},
	}
	for _, driver := range []storage.Driver{fsDriver, noRange{fsDriver}} {
		for _, c := range cases {
			t.Run(driver.Name()+"/"+c.name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, "/v2/acme/app/blobs/"+digest, nil)
				if c.rangeHeader != "" {
					req.Header.Set("Range", c.rangeHeader)
				}
				rec := httptest.NewRecorder()
				written, status, err := writeBlobContent(rec, req, driver, digest, size)
				if err != nil {
					t.Fatal(err)
				}
				if status != c.wantStatus || rec.Code != c.wantStatus {
					t.Fatalf("status = %d (recorded %d), want %d", status, rec.Code, c.wantStatus)
				}
				if written != c.wantWritten {
					t.Errorf("written = %d, want %d", written, c.wantWritten)
				}
				if rec.Header().Get("Accept-Ranges") != "bytes" {
					t.Error("missing Accept-Ranges: bytes")
				}
				if got := rec.Header().Get("Content-Range"); got != c.wantCR {
					t.Errorf("Content-Range = %q, want %q", got, c.wantCR)
				}
				if c.wantLen != "" {
					if got := rec.Header().Get("Content-Length"); got != c.wantLen {
						t.Errorf("Content-Length = %q, want %q", got, c.wantLen)
					}
					if rec.Body.String() != c.wantBody {
						t.Errorf("body = %q, want %q", rec.Body.String(), c.wantBody)
					}
				} else if !bytes.Contains(rec.Body.Bytes(), []byte(CodeRangeInvalid)) {
					t.Errorf("416 body should carry %s, got %s", CodeRangeInvalid, rec.Body.String())
				}
			})
		}
	}

	// Missing content surfaces as storage.ErrNotFound for the caller to map.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Range", "bytes=0-1")
	if _, _, err := writeBlobContent(httptest.NewRecorder(), req, fsDriver, "sha256:00", 5); err != storage.ErrNotFound {
		t.Errorf("missing blob (range): err = %v", err)
	}
	if _, _, err := writeBlobContent(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil), fsDriver, "sha256:00", 5); err != storage.ErrNotFound {
		t.Errorf("missing blob (full): err = %v", err)
	}
}
