package storage

import (
	"context"
	"fmt"
	"io"
)

// RangeReader is an optional interface a Driver can implement to serve part
// of a blob without transferring the whole object (HTTP Range requests).
// Drivers that do not implement it are served by OpenRange's generic
// fallback, which reads and discards the leading bytes.
type RangeReader interface {
	// OpenRange opens the blob at offset and delivers exactly length bytes
	// (offset+length never exceeds the blob size; the caller validated the
	// range against Stat/Get's size beforehand).
	OpenRange(ctx context.Context, digest string, offset, length int64) (io.ReadCloser, error)
}

// OpenRange returns a reader over [offset, offset+length) of the blob using
// the driver's native range support when available, and a read-and-discard
// fallback otherwise.
func OpenRange(ctx context.Context, d Driver, digest string, offset, length int64) (io.ReadCloser, error) {
	if offset < 0 || length < 0 {
		return nil, fmt.Errorf("storage: invalid range offset=%d length=%d", offset, length)
	}
	if rr, ok := d.(RangeReader); ok {
		return rr.OpenRange(ctx, digest, offset, length)
	}
	body, size, err := d.Get(ctx, digest)
	if err != nil {
		return nil, err
	}
	if offset+length > size {
		body.Close()
		return nil, fmt.Errorf("storage: range %d+%d exceeds blob size %d", offset, length, size)
	}
	return SkipAndLimit(body, offset, length)
}

// SkipAndLimit discards offset bytes from rc and limits what follows to
// length bytes. The returned reader closes rc.
func SkipAndLimit(rc io.ReadCloser, offset, length int64) (io.ReadCloser, error) {
	if offset > 0 {
		if _, err := io.CopyN(io.Discard, rc, offset); err != nil {
			rc.Close()
			return nil, fmt.Errorf("storage: skip %d bytes: %w", offset, err)
		}
	}
	return &limitedReadCloser{Reader: io.LimitReader(rc, length), Closer: rc}, nil
}

type limitedReadCloser struct {
	io.Reader
	io.Closer
}
