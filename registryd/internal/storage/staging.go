package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrUploadNotFound is returned for unknown or expired upload sessions.
var ErrUploadNotFound = errors.New("upload session not found")

// Staging manages in-progress blob uploads on local disk. Chunks are appended
// to a session file; on commit the file's digest is verified and the content
// is handed to the storage driver in one streaming write. This keeps partial
// or abandoned uploads out of the backend entirely.
//
// Note: sessions are node-local, so a multi-replica deployment needs sticky
// routing on /blobs/uploads/ paths (or a shared staging volume).
type Staging struct {
	dir string
}

type sessionMeta struct {
	Repository string    `json:"repository"`
	StartedAt  time.Time `json:"startedAt"`
}

func NewStaging(dir string) (*Staging, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}
	return &Staging{dir: dir}, nil
}

func (s *Staging) dataPath(id string) string { return filepath.Join(s.dir, id+".data") }
func (s *Staging) metaPath(id string) string { return filepath.Join(s.dir, id+".json") }

// Create opens a new upload session for the given repository.
func (s *Staging) Create(id, repository string) error {
	meta, err := json.Marshal(sessionMeta{Repository: repository, StartedAt: time.Now().UTC()})
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.metaPath(id), meta, 0o644); err != nil {
		return err
	}
	f, err := os.OpenFile(s.dataPath(id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return f.Close()
}

// Repository returns the repository an upload session belongs to.
func (s *Staging) Repository(id string) (string, error) {
	raw, err := os.ReadFile(s.metaPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrUploadNotFound
		}
		return "", err
	}
	var m sessionMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	return m.Repository, nil
}

// Size returns the number of bytes staged so far.
func (s *Staging) Size(id string) (int64, error) {
	info, err := os.Stat(s.dataPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, ErrUploadNotFound
		}
		return 0, err
	}
	return info.Size(), nil
}

// Append writes a chunk at the end of the session file and returns the new
// total size.
func (s *Staging) Append(id string, r io.Reader) (int64, error) {
	f, err := os.OpenFile(s.dataPath(id), os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, ErrUploadNotFound
		}
		return 0, err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	return s.Size(id)
}

// Digest computes the sha256 digest and size of the staged content.
func (s *Staging) Digest(id string) (string, int64, error) {
	f, err := os.Open(s.dataPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", 0, ErrUploadNotFound
		}
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), n, nil
}

// Open returns a reader over the staged content for committing to the driver.
func (s *Staging) Open(id string) (io.ReadCloser, error) {
	f, err := os.Open(s.dataPath(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrUploadNotFound
	}
	return f, err
}

// Remove deletes the session files.
func (s *Staging) Remove(id string) {
	_ = os.Remove(s.dataPath(id))
	_ = os.Remove(s.metaPath(id))
}

// Sweep removes sessions older than ttl and returns how many were removed.
func (s *Staging) Sweep(ttl time.Duration) int {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0
	}
	removed := 0
	cutoff := time.Now().Add(-ttl)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		// The data file's mtime advances with every chunk; only sweep
		// sessions whose data is also stale.
		id := strings.TrimSuffix(name, ".json")
		if dinfo, err := os.Stat(s.dataPath(id)); err == nil && dinfo.ModTime().After(cutoff) {
			continue
		}
		s.Remove(id)
		removed++
	}
	return removed
}
