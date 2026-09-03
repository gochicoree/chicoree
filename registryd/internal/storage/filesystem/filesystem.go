// Package filesystem stores blobs under a directory on a local or mounted
// path. Selected with STORAGE_DRIVER=filesystem.
package filesystem

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"registryd/internal/storage"
)

func init() {
	storage.Register(&storage.Plugin{
		Name:        "filesystem",
		Description: "Local or mounted directory (NFS, hostPath, docker volume).",
		Options: []storage.OptionDoc{
			{Key: "ROOT", Description: "Directory that holds the blobs/ tree", Default: "/var/lib/registry"},
		},
		New: func(_ context.Context, opts storage.Options) (storage.Driver, error) {
			return New(storage.Get(opts, "ROOT", "/var/lib/registry"))
		},
	})
}

// Driver is the filesystem backend.
type Driver struct {
	root string
}

// New creates the root directory if needed.
func New(root string) (*Driver, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create storage root: %w", err)
	}
	return &Driver{root: root}, nil
}

func (d *Driver) Name() string { return "filesystem" }

func (d *Driver) path(digest string) string {
	return filepath.Join(d.root, filepath.FromSlash(storage.BlobPath(digest)))
}

func (d *Driver) Get(_ context.Context, digest string) (io.ReadCloser, int64, error) {
	file, err := os.Open(d.path(digest))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, storage.ErrNotFound
		}
		return nil, 0, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, 0, err
	}
	return file, info.Size(), nil
}

func (d *Driver) Stat(_ context.Context, digest string) (int64, error) {
	info, err := os.Stat(d.path(digest))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, storage.ErrNotFound
		}
		return 0, err
	}
	return info.Size(), nil
}

func (d *Driver) Put(_ context.Context, digest string, r io.Reader, size int64) error {
	dst := d.path(digest)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".put-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("short write: got %d bytes, want %d", n, size)
	}
	return os.Rename(tmp.Name(), dst)
}

func (d *Driver) Delete(_ context.Context, digest string) error {
	err := os.Remove(d.path(digest))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (d *Driver) RedirectURL(context.Context, string) (string, error) { return "", nil }

// OpenRange implements storage.RangeReader with a seek, so partial reads
// never touch the bytes before the offset.
func (d *Driver) OpenRange(_ context.Context, digest string, offset, length int64) (io.ReadCloser, error) {
	file, err := os.Open(d.path(digest))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, storage.ErrNotFound
		}
		return nil, err
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return &rangeFile{Reader: io.LimitReader(file, length), file: file}, nil
}

type rangeFile struct {
	io.Reader
	file *os.File
}

func (r *rangeFile) Close() error { return r.file.Close() }
