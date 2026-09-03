package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

// memDriver has no native range support, so OpenRange must fall back.
type memDriver struct {
	fakeDriver
	data map[string][]byte
}

func (m memDriver) Get(_ context.Context, digest string) (io.ReadCloser, int64, error) {
	b, ok := m.data[digest]
	if !ok {
		return nil, 0, ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(b)), int64(len(b)), nil
}

func TestOpenRangeFallback(t *testing.T) {
	d := memDriver{data: map[string][]byte{"sha256:abc": []byte("0123456789")}}
	cases := []struct {
		offset, length int64
		want           string
	}{
		{0, 10, "0123456789"},
		{0, 3, "012"},
		{5, 5, "56789"},
		{9, 1, "9"},
		{4, 0, ""},
	}
	for _, c := range cases {
		rc, err := OpenRange(context.Background(), d, "sha256:abc", c.offset, c.length)
		if err != nil {
			t.Fatalf("OpenRange(%d,%d): %v", c.offset, c.length, err)
		}
		got, _ := io.ReadAll(rc)
		rc.Close()
		if string(got) != c.want {
			t.Errorf("OpenRange(%d,%d) = %q, want %q", c.offset, c.length, got, c.want)
		}
	}
	if _, err := OpenRange(context.Background(), d, "sha256:abc", 8, 5); err == nil {
		t.Error("expected an error for a range past the end")
	}
	if _, err := OpenRange(context.Background(), d, "sha256:missing", 0, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}
