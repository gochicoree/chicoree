package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// UploadChunk is one staged piece of a shared session, in append order.
type UploadChunk struct {
	Seq  int    `json:"seq"`
	Size int64  `json:"size"`
	Key  string `json:"key"`
}

// UploadSessionRow mirrors an upload_sessions row.
type UploadSessionRow struct {
	ID     string
	Org    string
	Repo   string
	Offset int64
	Chunks []UploadChunk
}

// SessionStore persists shared upload sessions (implemented by
// internal/store on Postgres). Results use "found" flags rather than errors
// so the store package needs nothing from this one.
type SessionStore interface {
	CreateUploadSession(ctx context.Context, id, org, repo, node string, expiresAt time.Time) error
	// GetUploadSession returns nil, nil for an unknown id.
	GetUploadSession(ctx context.Context, id string) (*UploadSessionRow, error)
	// AppendUploadChunk advances the session by chunk.Size and records the
	// chunk, but only when the stored offset still equals expected (the
	// optimistic lock). ok is false when the row is gone or has moved on.
	AppendUploadChunk(ctx context.Context, id string, expected int64, chunk UploadChunk, expiresAt time.Time) (offset int64, ok bool, err error)
	// DeleteUploadSession removes the row and returns it (nil when absent).
	DeleteUploadSession(ctx context.Context, id string) (*UploadSessionRow, error)
	// DeleteExpiredUploadSessions removes every session past its expiry and
	// returns the rows so their chunks can be cleaned up.
	DeleteExpiredUploadSessions(ctx context.Context) ([]UploadSessionRow, error)
	// ListUploadSessionIDs returns the ids of every live session.
	ListUploadSessionIDs(ctx context.Context) ([]string, error)
}

// SharedStaging keeps session state in Postgres and chunk bytes in the
// storage backend (under UploadsPrefix), so PATCH, PUT, GET and DELETE on an
// upload may land on any replica. Concurrent appends to one session are
// serialised by the offset check in AppendUploadChunk: the loser's chunk is
// discarded and it answers with a range error, exactly as a client that
// resumed from a stale offset would see.
type SharedStaging struct {
	objects  ObjectStore
	sessions SessionStore
	node     string
	ttl      time.Duration
}

// NewSharedStaging wires the object store and session store together. node
// is recorded on sessions for diagnostics only.
func NewSharedStaging(objects ObjectStore, sessions SessionStore, node string, ttl time.Duration) *SharedStaging {
	return &SharedStaging{objects: objects, sessions: sessions, node: node, ttl: ttl}
}

func (s *SharedStaging) Mode() string { return "shared" }

func (s *SharedStaging) expiry() time.Time { return time.Now().Add(s.ttl) }

func (s *SharedStaging) Create(ctx context.Context, id, org, repo string) error {
	return s.sessions.CreateUploadSession(ctx, id, org, repo, s.node, s.expiry())
}

func (s *SharedStaging) Get(ctx context.Context, id string) (*UploadSession, error) {
	row, err := s.sessions.GetUploadSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrUploadNotFound
	}
	return &UploadSession{ID: id, Org: row.Org, Repo: row.Repo, Offset: row.Offset}, nil
}

// chunkKey builds the object key for a chunk. The random suffix keeps two
// replicas that race for the same sequence number from writing one key.
func chunkKey(id string, seq int) string {
	var nonce [4]byte
	_, _ = rand.Read(nonce[:])
	return UploadsPrefix + id + "/" + strconv.Itoa(seq) + "-" + hex.EncodeToString(nonce[:])
}

// SessionOfKey extracts the session id from a chunk key ("" when the key is
// not a chunk key).
func SessionOfKey(key string) string {
	rest, ok := strings.CutPrefix(key, UploadsPrefix)
	if !ok {
		return ""
	}
	id, _, _ := strings.Cut(rest, "/")
	return id
}

func (s *SharedStaging) Append(ctx context.Context, id string, expected int64, r io.Reader) (int64, error) {
	row, err := s.sessions.GetUploadSession(ctx, id)
	if err != nil {
		return 0, err
	}
	if row == nil {
		return 0, ErrUploadNotFound
	}
	if row.Offset != expected {
		return row.Offset, ErrOffsetMismatch
	}
	// Stream the body into its own object first; the row is only advanced
	// once the bytes are safely stored.
	chunk := UploadChunk{Seq: len(row.Chunks), Key: chunkKey(id, len(row.Chunks))}
	n, err := s.objects.PutObject(ctx, chunk.Key, r, -1)
	if err != nil {
		_ = s.objects.DeleteObject(ctx, chunk.Key)
		return 0, err
	}
	chunk.Size = n
	offset, ok, err := s.sessions.AppendUploadChunk(ctx, id, expected, chunk, s.expiry())
	if err != nil {
		_ = s.objects.DeleteObject(ctx, chunk.Key)
		return 0, err
	}
	if !ok {
		// Lost the race (or the session vanished meanwhile): drop our copy
		// and tell the caller where the session actually stands.
		_ = s.objects.DeleteObject(ctx, chunk.Key)
		row, err := s.sessions.GetUploadSession(ctx, id)
		if err != nil {
			return 0, err
		}
		if row == nil {
			return 0, ErrUploadNotFound
		}
		return row.Offset, ErrOffsetMismatch
	}
	return offset, nil
}

func (s *SharedStaging) Open(ctx context.Context, id string) (io.ReadCloser, int64, error) {
	row, err := s.sessions.GetUploadSession(ctx, id)
	if err != nil {
		return nil, 0, err
	}
	if row == nil {
		return nil, 0, ErrUploadNotFound
	}
	return &chunkReader{ctx: ctx, objects: s.objects, chunks: row.Chunks}, row.Offset, nil
}

// chunkReader concatenates chunk objects, opening each one lazily.
type chunkReader struct {
	ctx     context.Context
	objects ObjectStore
	chunks  []UploadChunk
	next    int
	cur     io.ReadCloser
}

func (c *chunkReader) Read(p []byte) (int, error) {
	for {
		if c.cur == nil {
			if c.next >= len(c.chunks) {
				return 0, io.EOF
			}
			chunk := c.chunks[c.next]
			rc, size, err := c.objects.GetObject(c.ctx, chunk.Key)
			if err != nil {
				return 0, fmt.Errorf("open upload chunk %s: %w", chunk.Key, err)
			}
			if size >= 0 && size != chunk.Size {
				rc.Close()
				return 0, fmt.Errorf("upload chunk %s is %d bytes, session recorded %d", chunk.Key, size, chunk.Size)
			}
			c.cur = rc
			c.next++
		}
		n, err := c.cur.Read(p)
		if err == io.EOF {
			c.cur.Close()
			c.cur = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *chunkReader) Close() error {
	if c.cur != nil {
		err := c.cur.Close()
		c.cur = nil
		return err
	}
	return nil
}

func (s *SharedStaging) Remove(ctx context.Context, id string) error {
	row, err := s.sessions.DeleteUploadSession(ctx, id)
	if err != nil {
		return err
	}
	if row == nil {
		return nil
	}
	s.deleteChunks(ctx, row.Chunks)
	return nil
}

func (s *SharedStaging) deleteChunks(ctx context.Context, chunks []UploadChunk) {
	for _, c := range chunks {
		if err := s.objects.DeleteObject(ctx, c.Key); err != nil {
			slog.Warn("staging: delete chunk failed (gc will retry)", "key", c.Key, "err", err)
		}
	}
}

// Sweep removes expired sessions with their chunks, then every object under
// UploadsPrefix that belongs to no live session (leftovers of crashed
// replicas or failed deletes). Objects are listed before the live ids are
// read, so a session opened meanwhile is never mistaken for an orphan.
func (s *SharedStaging) Sweep(ctx context.Context) (int, error) {
	expired, err := s.sessions.DeleteExpiredUploadSessions(ctx)
	if err != nil {
		return 0, err
	}
	for _, row := range expired {
		s.deleteChunks(ctx, row.Chunks)
	}
	removed := len(expired)

	objects, err := s.objects.ListObjects(ctx, UploadsPrefix)
	if err != nil {
		return removed, fmt.Errorf("list staged chunks: %w", err)
	}
	if len(objects) == 0 {
		return removed, nil
	}
	ids, err := s.sessions.ListUploadSessionIDs(ctx)
	if err != nil {
		return removed, err
	}
	live := make(map[string]bool, len(ids))
	for _, id := range ids {
		live[id] = true
	}
	orphans := map[string]bool{}
	for _, o := range objects {
		id := SessionOfKey(o.Key)
		if id == "" || live[id] {
			continue
		}
		if err := s.objects.DeleteObject(ctx, o.Key); err != nil {
			slog.Warn("staging: delete orphaned chunk failed", "key", o.Key, "err", err)
			continue
		}
		orphans[id] = true
	}
	return removed + len(orphans), nil
}

// ErrSharedStagingUnsupported is returned when the selected storage driver
// cannot hold staging chunks.
var ErrSharedStagingUnsupported = errors.New("storage driver does not support shared upload staging (no object store)")

// OpenStaging builds the staging implementation named by mode ("local" or
// "shared") for the given driver.
func OpenStaging(mode, dir string, driver Driver, sessions SessionStore, node string, ttl time.Duration) (Staging, error) {
	switch mode {
	case "", "local":
		return NewLocalStaging(dir, ttl)
	case "shared":
		objects, ok := driver.(ObjectStore)
		if !ok {
			return nil, fmt.Errorf("%w: driver %q", ErrSharedStagingUnsupported, driver.Name())
		}
		return NewSharedStaging(objects, sessions, node, ttl), nil
	default:
		return nil, fmt.Errorf("unknown STORAGE_STAGING mode %q (use local or shared)", mode)
	}
}
