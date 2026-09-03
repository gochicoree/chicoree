package filesystem

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"registryd/internal/storage"
)

func TestOpenRange(t *testing.T) {
	d, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	content := []byte("The quick brown fox jumps over the lazy dog")
	if err := d.Put(context.Background(), digest, bytes.NewReader(content), int64(len(content))); err != nil {
		t.Fatal(err)
	}
	var _ storage.RangeReader = d // compile-time: the driver serves ranges natively

	cases := []struct {
		offset, length int64
		want           string
	}{
		{0, 3, "The"},
		{4, 5, "quick"},
		{40, 3, "dog"},
		{0, int64(len(content)), string(content)},
		{10, 0, ""},
	}
	for _, c := range cases {
		rc, err := storage.OpenRange(context.Background(), d, digest, c.offset, c.length)
		if err != nil {
			t.Fatalf("OpenRange(%d,%d): %v", c.offset, c.length, err)
		}
		got, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != c.want {
			t.Errorf("OpenRange(%d,%d) = %q, want %q", c.offset, c.length, got, c.want)
		}
	}

	if _, err := d.OpenRange(context.Background(), "sha256:ffff", 0, 1); !errors.Is(err, storage.ErrNotFound) {
		t.Errorf("missing blob: got %v, want ErrNotFound", err)
	}
}
