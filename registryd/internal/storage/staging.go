package storage

import (
	"context"
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

// ErrOffsetMismatch is returned by Append when the caller's idea of the
// staged size is stale: another request appended first, or the client sent
// a Content-Range that does not continue where the session stands.
var ErrOffsetMismatch = errors.New("upload offset mismatch")

// UploadSession is what the API needs to know about an in-flight upload.
type UploadSession struct {
	ID string
	// Org and Repo are the resolved organization slug and repository name the
	// session was opened for; every request on the session must match them.
	Org  string
	Repo string
	// Offset is the number of bytes staged so far.
	Offset int64
}

// Staging holds blob uploads between the first byte and the commit, keeping
// partial or abandoned content out of the blob tree. Two implementations:
// LocalStaging (node-local files) and SharedStaging (sessions in Postgres,
// chunks in the storage backend, so any replica can serve any request).
type Staging interface {
	// Mode names the implementation for logs and the status endpoint.
	Mode() string
	// Create opens a session for the repository.
	Create(ctx context.Context, id, org, repo string) error
	// Get returns the session, or ErrUploadNotFound.
	Get(ctx context.Context, id string) (*UploadSession, error)
	// Append stages the next chunk. expected is the offset the caller has
	// verified the client is continuing from; when the session has moved on
	// (a concurrent append) Append writes nothing and returns
	// ErrOffsetMismatch. It returns the new offset.
	Append(ctx context.Context, id string, expected int64, r io.Reader) (int64, error)
	// Open streams the staged content, in order, and reports its size.
	Open(ctx context.Context, id string) (io.ReadCloser, int64, error)
	// Remove discards the session and its content. Removing an unknown
	// session is not an error.
	Remove(ctx context.Context, id string) error
	// Sweep discards sessions idle for longer than the configured TTL and
	// any content no session claims; it returns how many it removed.
	Sweep(ctx context.Context) (int, error)
}

// StagedDigest hashes a session's content and reports digest and size.
func StagedDigest(ctx context.Context, s Staging, id string) (string, int64, error) {
	rc, _, err := s.Open(ctx, id)
	if err != nil {
		return "", 0, err
	}
	defer rc.Close()
	return DigestOf(rc)
}

// LocalStaging keeps sessions on local disk: chunks are appended to a data
// file, metadata lives in a JSON file next to it. Sessions are node-local,
// so a multi-replica deployment needs sticky routing on /blobs/uploads/
// paths — or STORAGE_STAGING=shared.
type LocalStaging struct {
	dir string
	ttl time.Duration
}

type sessionMeta struct {
	Org       string    `json:"org"`
	Repo      string    `json:"repo"`
	StartedAt time.Time `json:"startedAt"`
}

// NewLocalStaging creates the staging directory if needed.
func NewLocalStaging(dir string, ttl time.Duration) (*LocalStaging, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}
	return &LocalStaging{dir: dir, ttl: ttl}, nil
}

func (s *LocalStaging) Mode() string { return "local" }

func (s *LocalStaging) dataPath(id string) string { return filepath.Join(s.dir, id+".data") }
func (s *LocalStaging) metaPath(id string) string { return filepath.Join(s.dir, id+".json") }

func (s *LocalStaging) Create(_ context.Context, id, org, repo string) error {
	meta, err := json.Marshal(sessionMeta{Org: org, Repo: repo, StartedAt: time.Now().UTC()})
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

func (s *LocalStaging) Get(_ context.Context, id string) (*UploadSession, error) {
	raw, err := os.ReadFile(s.metaPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrUploadNotFound
		}
		return nil, err
	}
	var m sessionMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	size, err := s.size(id)
	if err != nil {
		return nil, err
	}
	return &UploadSession{ID: id, Org: m.Org, Repo: m.Repo, Offset: size}, nil
}

func (s *LocalStaging) size(id string) (int64, error) {
	info, err := os.Stat(s.dataPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, ErrUploadNotFound
		}
		return 0, err
	}
	return info.Size(), nil
}

func (s *LocalStaging) Append(_ context.Context, id string, expected int64, r io.Reader) (int64, error) {
	current, err := s.size(id)
	if err != nil {
		return 0, err
	}
	if current != expected {
		return current, ErrOffsetMismatch
	}
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
	return s.size(id)
}

func (s *LocalStaging) Open(_ context.Context, id string) (io.ReadCloser, int64, error) {
	f, err := os.Open(s.dataPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, ErrUploadNotFound
		}
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

func (s *LocalStaging) Remove(_ context.Context, id string) error {
	_ = os.Remove(s.dataPath(id))
	_ = os.Remove(s.metaPath(id))
	return nil
}

func (s *LocalStaging) Sweep(ctx context.Context) (int, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0, err
	}
	removed := 0
	cutoff := time.Now().Add(-s.ttl)
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
		_ = s.Remove(ctx, id)
		removed++
	}
	return removed, nil
}
