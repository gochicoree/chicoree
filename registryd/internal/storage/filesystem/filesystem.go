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
	"path"
	"path/filepath"
	"strings"

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

// --- storage.ObjectStore: arbitrary keys under the root (shared staging) ---

func (d *Driver) objectPath(key string) (string, error) {
	if !storage.ValidObjectKey(key) {
		return "", fmt.Errorf("invalid object key %q", key)
	}
	return filepath.Join(d.root, filepath.FromSlash(key)), nil
}

// PutObject writes through a temporary file and renames it into place, so a
// reader that fails part-way leaves no object behind.
func (d *Driver) PutObject(_ context.Context, key string, r io.Reader, size int64) (int64, error) {
	dst, err := d.objectPath(key)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".obj-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	if size >= 0 && n != size {
		return 0, fmt.Errorf("short write: got %d bytes, want %d", n, size)
	}
	return n, os.Rename(tmp.Name(), dst)
}

func (d *Driver) GetObject(_ context.Context, key string) (io.ReadCloser, int64, error) {
	p, err := d.objectPath(key)
	if err != nil {
		return nil, 0, err
	}
	file, err := os.Open(p)
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

// DeleteObject removes the object and, when that leaves its directory
// empty, the directory too (session directories vanish with their last chunk).
func (d *Driver) DeleteObject(_ context.Context, key string) error {
	p, err := d.objectPath(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if dir := filepath.Dir(p); dir != d.root {
		_ = os.Remove(dir) // fails harmlessly while other objects remain
	}
	return nil
}

// ListObjects walks the directory the prefix points into and returns the
// files whose key starts with the prefix.
func (d *Driver) ListObjects(_ context.Context, prefix string) ([]storage.ObjectInfo, error) {
	dir := prefix
	if !strings.HasSuffix(dir, "/") {
		dir = path.Dir(dir)
	}
	dir = strings.Trim(dir, "/")
	if dir == "." {
		dir = ""
	}
	if dir != "" && !storage.ValidObjectKey(dir) {
		return nil, fmt.Errorf("invalid object prefix %q", prefix)
	}
	root := filepath.Join(d.root, filepath.FromSlash(dir))
	var out []storage.ObjectInfo
	err := filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if e.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return nil // vanished meanwhile
		}
		out = append(out, storage.ObjectInfo{Key: key, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return out, nil
}

// Root returns the directory the driver stores under.
func (d *Driver) Root() string { return d.root }
