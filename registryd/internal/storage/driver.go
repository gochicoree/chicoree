// Package storage provides content-addressable blob storage behind a small
// driver interface, and a plugin registry through which backends register
// themselves. Blobs are stored exactly once, keyed by digest; repository
// membership lives in Postgres, not in the storage layout.
//
// To add a backend: create a package under internal/storage/<name>, implement
// Driver, call storage.Register in init(), and blank-import the package from
// cmd/registryd. Operators select it with STORAGE_DRIVER=<name> and configure
// it with <NAME>_<OPTION> environment variables.
package storage

import (
	"context"
	"errors"
	"io"
	"strings"
)

// ErrNotFound is returned when a blob does not exist in the backend.
var ErrNotFound = errors.New("blob not found in storage")

// Driver stores and retrieves immutable, digest-addressed blobs. In-progress
// uploads never touch the driver; they are staged locally (see Staging) and
// committed with Put once the digest is verified.
type Driver interface {
	// Get opens the blob for reading and reports its size.
	Get(ctx context.Context, digest string) (io.ReadCloser, int64, error)
	// Stat reports the blob size, or ErrNotFound.
	Stat(ctx context.Context, digest string) (int64, error)
	// Put writes the blob. The reader delivers exactly size bytes whose
	// digest has already been verified by the caller.
	Put(ctx context.Context, digest string, r io.Reader, size int64) error
	// Delete removes the blob. Deleting a missing blob is not an error.
	Delete(ctx context.Context, digest string) error
	// RedirectURL returns a temporary direct-download URL for the blob, or
	// "" when the driver does not support (or is not configured for) redirects.
	RedirectURL(ctx context.Context, digest string) (string, error)
	// Name identifies the driver for logs and health output.
	Name() string
}

// BlobPath fans digests out into two-level directories / key prefixes:
// blobs/sha256/ab/abcdef... Keeps directory sizes sane on filesystems and
// mirrors the layout of other registries for operator familiarity.
func BlobPath(digest string) string {
	algo, hex, ok := strings.Cut(digest, ":")
	if !ok || algo == "" || hex == "" {
		return "blobs/invalid/" + digest
	}
	prefix := hex
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	return "blobs/" + algo + "/" + prefix + "/" + hex
}

// DigestHex returns the hex part of a digest ("sha256:abc" → "abc").
func DigestHex(digest string) string {
	_, hex, _ := strings.Cut(digest, ":")
	return hex
}
