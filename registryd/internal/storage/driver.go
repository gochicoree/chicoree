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
	"time"
)

// ErrNotFound is returned when a blob does not exist in the backend.
var ErrNotFound = errors.New("blob not found in storage")

// Driver stores and retrieves immutable, digest-addressed blobs. In-progress
// uploads never touch the blob tree; they are staged (see Staging) and
// committed with Put, whose reader verifies the digest as it streams.
type Driver interface {
	// Get opens the blob for reading and reports its size.
	Get(ctx context.Context, digest string) (io.ReadCloser, int64, error)
	// Stat reports the blob size, or ErrNotFound.
	Stat(ctx context.Context, digest string) (int64, error)
	// Put writes the blob. The reader delivers exactly size bytes; it may
	// fail at the very end (see VerifyingReader), in which case the blob
	// must not become visible — write to a temporary location and only
	// publish once the reader has returned io.EOF and the size matches.
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

// ObjectStore is an optional driver interface for backends that can hold
// arbitrary keyed objects next to the blob tree. Shared upload staging
// (STORAGE_STAGING=shared) keeps in-flight chunks under the reserved
// "_uploads/" prefix through it, so every registryd replica sees the same
// session data. Keys are slash-separated paths relative to the storage root.
type ObjectStore interface {
	// PutObject writes an object. size is the byte count when the caller
	// knows it, else -1; the number of bytes actually written is returned.
	PutObject(ctx context.Context, key string, r io.Reader, size int64) (int64, error)
	// GetObject opens an object and reports its size, or ErrNotFound.
	GetObject(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// DeleteObject removes an object. Deleting a missing key is not an error.
	DeleteObject(ctx context.Context, key string) error
	// ListObjects returns every object whose key starts with prefix.
	ListObjects(ctx context.Context, prefix string) ([]ObjectInfo, error)
}

// ObjectInfo describes one stored object.
type ObjectInfo struct {
	Key     string
	Size    int64
	ModTime time.Time
}

// UploadsPrefix is the key prefix reserved for shared staging chunks; GC
// treats anything beneath it that belongs to no session as garbage.
const UploadsPrefix = "_uploads/"

// ValidObjectKey reports whether a key is a clean relative path (no empty,
// "." or ".." segments), so drivers can map it onto a filesystem safely.
func ValidObjectKey(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") {
		return false
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// BlobsPrefix is the key prefix under which every driver keeps blob content;
// ListObjects(BlobsPrefix) on an ObjectStore enumerates the blob tree.
const BlobsPrefix = "blobs/"

// DigestFromPath is the inverse of BlobPath: it turns a storage key such as
// blobs/sha256/ab/abcdef… back into "sha256:abcdef…". Keys that are not a
// well-formed blob path (temporary files, foreign objects, a hex part that
// does not match its directory) yield ok == false.
func DigestFromPath(key string) (digest string, ok bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 4 || parts[0] != "blobs" {
		return "", false
	}
	algo, prefix, hex := parts[1], parts[2], parts[3]
	if algo == "" || len(hex) < 3 || !strings.HasPrefix(hex, prefix) || len(prefix) != 2 {
		return "", false
	}
	for _, c := range hex {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	return algo + ":" + hex, true
}

// Describer is an optional driver interface that names where the driver
// keeps its data (a directory, a bucket, a storage zone) for logs, the
// status endpoint and the storage tools.
type Describer interface {
	Describe() string
}

// Describe returns the driver's location when it has one, else its name.
func Describe(d Driver) string {
	if dd, ok := d.(Describer); ok {
		if s := dd.Describe(); s != "" {
			return s
		}
	}
	return d.Name()
}
