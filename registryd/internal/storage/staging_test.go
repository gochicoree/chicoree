package storage_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"registryd/internal/storage"
	"registryd/internal/storage/filesystem"
)

// memSessions is an in-memory storage.SessionStore with the same optimistic
// locking semantics as the Postgres implementation.
type memSessions struct {
	mu   sync.Mutex
	rows map[string]*memRow
	// failNextAppend makes the next AppendUploadChunk report a lost race.
	failNextAppend bool
}

type memRow struct {
	storage.UploadSessionRow
	expiresAt time.Time
}

func newMemSessions() *memSessions { return &memSessions{rows: map[string]*memRow{}} }

func (m *memSessions) CreateUploadSession(_ context.Context, id, org, repo, node string, expiresAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[id] = &memRow{UploadSessionRow: storage.UploadSessionRow{ID: id, Org: org, Repo: repo}, expiresAt: expiresAt}
	return nil
}

func (m *memSessions) GetUploadSession(_ context.Context, id string) (*storage.UploadSessionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil, nil
	}
	cp := r.UploadSessionRow
	cp.Chunks = append([]storage.UploadChunk(nil), r.Chunks...)
	return &cp, nil
}

func (m *memSessions) AppendUploadChunk(_ context.Context, id string, expected int64, chunk storage.UploadChunk, expiresAt time.Time) (int64, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failNextAppend {
		m.failNextAppend = false
		return 0, false, nil
	}
	r, ok := m.rows[id]
	if !ok || r.Offset != expected {
		return 0, false, nil
	}
	r.Chunks = append(r.Chunks, chunk)
	r.Offset += chunk.Size
	r.expiresAt = expiresAt
	return r.Offset, true, nil
}

func (m *memSessions) DeleteUploadSession(_ context.Context, id string) (*storage.UploadSessionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil, nil
	}
	delete(m.rows, id)
	return &r.UploadSessionRow, nil
}

func (m *memSessions) DeleteExpiredUploadSessions(context.Context) ([]storage.UploadSessionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []storage.UploadSessionRow
	for id, r := range m.rows {
		if r.expiresAt.Before(time.Now()) {
			out = append(out, r.UploadSessionRow)
			delete(m.rows, id)
		}
	}
	return out, nil
}

func (m *memSessions) ListUploadSessionIDs(context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for id := range m.rows {
		ids = append(ids, id)
	}
	return ids, nil
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func newShared(t *testing.T, ttl time.Duration) (*storage.SharedStaging, *filesystem.Driver, *memSessions) {
	t.Helper()
	drv, err := filesystem.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var _ storage.ObjectStore = drv
	sessions := newMemSessions()
	return storage.NewSharedStaging(drv, sessions, "node-a", ttl), drv, sessions
}

func listUploads(t *testing.T, drv *filesystem.Driver) []string {
	t.Helper()
	objs, err := drv.ListObjects(context.Background(), storage.UploadsPrefix)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, o := range objs {
		keys = append(keys, o.Key)
	}
	return keys
}

func TestSharedStagingAppendOpenCommit(t *testing.T) {
	ctx := context.Background()
	st, drv, _ := newShared(t, time.Hour)

	if err := st.Create(ctx, "s1", "acme", "alpine"); err != nil {
		t.Fatal(err)
	}
	sess, err := st.Get(ctx, "s1")
	if err != nil || sess.Org != "acme" || sess.Repo != "alpine" || sess.Offset != 0 {
		t.Fatalf("Get = %+v, %v", sess, err)
	}
	if n, err := st.Append(ctx, "s1", 0, strings.NewReader("hello ")); err != nil || n != 6 {
		t.Fatalf("append 1 = %d, %v", n, err)
	}
	if n, err := st.Append(ctx, "s1", 6, strings.NewReader("world")); err != nil || n != 11 {
		t.Fatalf("append 2 = %d, %v", n, err)
	}
	if keys := listUploads(t, drv); len(keys) != 2 || storage.SessionOfKey(keys[0]) != "s1" {
		t.Fatalf("chunk objects = %v", keys)
	}
	rc, size, err := st.Open(ctx, "s1")
	if err != nil || size != 11 {
		t.Fatalf("Open = size %d, %v", size, err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil || string(got) != "hello world" {
		t.Fatalf("content = %q, %v", got, err)
	}

	// Commit the way the API does: hash while streaming into the driver.
	want := digestOf([]byte("hello world"))
	rc, size, _ = st.Open(ctx, "s1")
	err = drv.Put(ctx, want, storage.NewVerifyingReader(rc, want), size)
	rc.Close()
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n, err := drv.Stat(ctx, want); err != nil || n != 11 {
		t.Fatalf("Stat after commit = %d, %v", n, err)
	}
	if err := st.Remove(ctx, "s1"); err != nil {
		t.Fatal(err)
	}
	if keys := listUploads(t, drv); len(keys) != 0 {
		t.Fatalf("chunks left after remove: %v", keys)
	}
	if _, err := st.Get(ctx, "s1"); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("Get after remove = %v, want ErrUploadNotFound", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(drv.Root(), "_uploads")); len(entries) != 0 {
		t.Fatalf("session directory not cleaned up: %v", entries)
	}
}

func TestSharedStagingOffsetMismatch(t *testing.T) {
	ctx := context.Background()
	st, drv, sessions := newShared(t, time.Hour)
	_ = st.Create(ctx, "s1", "acme", "alpine")
	if _, err := st.Append(ctx, "s1", 0, strings.NewReader("abc")); err != nil {
		t.Fatal(err)
	}

	// Stale offset: nothing is written.
	n, err := st.Append(ctx, "s1", 0, strings.NewReader("xyz"))
	if !errors.Is(err, storage.ErrOffsetMismatch) || n != 3 {
		t.Fatalf("stale append = %d, %v; want 3, ErrOffsetMismatch", n, err)
	}
	if keys := listUploads(t, drv); len(keys) != 1 {
		t.Fatalf("stale append left objects: %v", keys)
	}

	// Lost race: the chunk was written, the row moved on meanwhile — the
	// chunk is discarded again and the caller learns the real offset.
	sessions.failNextAppend = true
	n, err = st.Append(ctx, "s1", 3, strings.NewReader("xyz"))
	if !errors.Is(err, storage.ErrOffsetMismatch) || n != 3 {
		t.Fatalf("raced append = %d, %v; want 3, ErrOffsetMismatch", n, err)
	}
	if keys := listUploads(t, drv); len(keys) != 1 {
		t.Fatalf("raced append left objects: %v", keys)
	}

	if _, err := st.Append(ctx, "nope", 0, strings.NewReader("x")); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("unknown session append = %v", err)
	}
}

func TestSharedStagingCancel(t *testing.T) {
	ctx := context.Background()
	st, drv, _ := newShared(t, time.Hour)
	_ = st.Create(ctx, "s1", "acme", "alpine")
	_, _ = st.Append(ctx, "s1", 0, strings.NewReader("abc"))
	if err := st.Remove(ctx, "s1"); err != nil {
		t.Fatal(err)
	}
	if keys := listUploads(t, drv); len(keys) != 0 {
		t.Fatalf("objects after cancel: %v", keys)
	}
	if err := st.Remove(ctx, "s1"); err != nil {
		t.Fatalf("second remove: %v", err)
	}
	if _, _, err := st.Open(ctx, "s1"); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("Open after cancel = %v", err)
	}
}

func TestSharedStagingCommitDigestMismatch(t *testing.T) {
	ctx := context.Background()
	st, drv, _ := newShared(t, time.Hour)
	_ = st.Create(ctx, "s1", "acme", "alpine")
	_, _ = st.Append(ctx, "s1", 0, strings.NewReader("hello "))
	_, _ = st.Append(ctx, "s1", 6, strings.NewReader("world"))

	claimed := digestOf([]byte("something else"))
	rc, size, _ := st.Open(ctx, "s1")
	err := drv.Put(ctx, claimed, storage.NewVerifyingReader(rc, claimed), size)
	rc.Close()
	if !errors.Is(err, storage.ErrDigestMismatch) {
		t.Fatalf("Put with wrong digest = %v, want ErrDigestMismatch", err)
	}
	if !strings.Contains(err.Error(), "client sent "+claimed) || !strings.Contains(err.Error(), digestOf([]byte("hello world"))) {
		t.Fatalf("error should name both digests: %v", err)
	}
	if _, err := drv.Stat(ctx, claimed); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("blob became visible despite mismatch: %v", err)
	}
	// No temp file lingers in the blob tree.
	if matches, _ := filepath.Glob(filepath.Join(drv.Root(), "blobs", "sha256", "*", ".put-*")); len(matches) != 0 {
		t.Fatalf("temp files left behind: %v", matches)
	}
}

func TestSharedStagingSweep(t *testing.T) {
	ctx := context.Background()
	live, drv, sessions := newShared(t, time.Hour)
	expired := storage.NewSharedStaging(drv, sessions, "node-b", time.Millisecond)

	_ = live.Create(ctx, "live", "acme", "alpine")
	_, _ = live.Append(ctx, "live", 0, strings.NewReader("keep"))
	_ = expired.Create(ctx, "old", "acme", "alpine")
	_, _ = expired.Append(ctx, "old", 0, strings.NewReader("stale"))
	// An orphan: chunk objects whose session row is gone (crashed replica).
	if _, err := drv.PutObject(ctx, storage.UploadsPrefix+"ghost/0-deadbeef", strings.NewReader("orphan"), -1); err != nil {
		t.Fatal(err)
	}
	if _, err := drv.PutObject(ctx, storage.UploadsPrefix+"ghost/1-deadbeef", strings.NewReader("orphan"), -1); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)

	n, err := live.Sweep(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("Sweep removed %d, want 2 (one expired session, one orphan)", n)
	}
	keys := listUploads(t, drv)
	if len(keys) != 1 || storage.SessionOfKey(keys[0]) != "live" {
		t.Fatalf("objects after sweep = %v, want only the live chunk", keys)
	}
	if _, err := live.Get(ctx, "old"); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("expired session still present: %v", err)
	}
	if sess, err := live.Get(ctx, "live"); err != nil || sess.Offset != 4 {
		t.Fatalf("live session damaged: %+v, %v", sess, err)
	}
	if n, err := live.Sweep(ctx); err != nil || n != 0 {
		t.Fatalf("second sweep = %d, %v", n, err)
	}
}

func TestSharedStagingEmptyAndManyChunks(t *testing.T) {
	ctx := context.Background()
	st, drv, _ := newShared(t, time.Hour)
	_ = st.Create(ctx, "s1", "acme", "alpine")
	rc, size, err := st.Open(ctx, "s1")
	if err != nil || size != 0 {
		t.Fatalf("Open empty = %d, %v", size, err)
	}
	if got, _ := io.ReadAll(rc); len(got) != 0 {
		t.Fatalf("empty session read %d bytes", len(got))
	}
	rc.Close()

	// Chunks of assorted sizes, including an empty one, reassemble in order.
	var want bytes.Buffer
	var offset int64
	for i, size := range []int{1000, 0, 70000, 1, 4096} {
		chunk := make([]byte, size)
		_, _ = rand.Read(chunk)
		for j := range chunk {
			chunk[j] = byte(i) ^ chunk[j]
		}
		want.Write(chunk)
		n, err := st.Append(ctx, "s1", offset, bytes.NewReader(chunk))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		offset = n
	}
	rc, size, _ = st.Open(ctx, "s1")
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil || size != int64(want.Len()) || !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("reassembled %d bytes (size %d), want %d; err %v", len(got), size, want.Len(), err)
	}
	if keys := listUploads(t, drv); len(keys) != 5 {
		t.Fatalf("chunk objects = %d, want 5", len(keys))
	}
}

func TestLocalStaging(t *testing.T) {
	ctx := context.Background()
	st, err := storage.NewLocalStaging(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var _ storage.Staging = st
	if st.Mode() != "local" {
		t.Fatal("mode")
	}
	_ = st.Create(ctx, "s1", "acme", "alpine")
	if n, err := st.Append(ctx, "s1", 0, strings.NewReader("abc")); err != nil || n != 3 {
		t.Fatalf("append = %d, %v", n, err)
	}
	if n, err := st.Append(ctx, "s1", 1, strings.NewReader("abc")); !errors.Is(err, storage.ErrOffsetMismatch) || n != 3 {
		t.Fatalf("stale append = %d, %v", n, err)
	}
	sess, err := st.Get(ctx, "s1")
	if err != nil || sess.Org != "acme" || sess.Repo != "alpine" || sess.Offset != 3 {
		t.Fatalf("Get = %+v, %v", sess, err)
	}
	digest, n, err := storage.StagedDigest(ctx, st, "s1")
	if err != nil || n != 3 || digest != digestOf([]byte("abc")) {
		t.Fatalf("StagedDigest = %s, %d, %v", digest, n, err)
	}
	_ = st.Remove(ctx, "s1")
	if _, err := st.Get(ctx, "s1"); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("after remove: %v", err)
	}
	if _, err := st.Append(ctx, "s1", 0, strings.NewReader("x")); !errors.Is(err, storage.ErrUploadNotFound) {
		t.Fatalf("append after remove: %v", err)
	}

	// Sweep: only idle sessions older than the TTL go.
	stale, _ := storage.NewLocalStaging(t.TempDir(), time.Millisecond)
	_ = stale.Create(ctx, "old", "acme", "alpine")
	time.Sleep(5 * time.Millisecond)
	if n, err := stale.Sweep(ctx); err != nil || n != 1 {
		t.Fatalf("Sweep = %d, %v", n, err)
	}
	if n, _ := st.Sweep(ctx); n != 0 {
		t.Fatalf("fresh staging swept %d", n)
	}
}

func TestVerifyingReader(t *testing.T) {
	content := []byte("The quick brown fox")
	v := storage.NewVerifyingReader(bytes.NewReader(content), digestOf(content))
	got, err := io.ReadAll(v)
	if err != nil || !bytes.Equal(got, content) || v.Size() != int64(len(content)) {
		t.Fatalf("good digest: %v (%d bytes)", err, len(got))
	}

	v = storage.NewVerifyingReader(bytes.NewReader(content), digestOf([]byte("other")))
	if _, err := io.ReadAll(v); !errors.Is(err, storage.ErrDigestMismatch) {
		t.Fatalf("bad digest: %v", err)
	}
	// The error sticks: a driver that keeps reading sees it again, never EOF.
	if _, err := v.Read(make([]byte, 1)); !errors.Is(err, storage.ErrDigestMismatch) {
		t.Fatalf("repeated read: %v", err)
	}

	// Empty content hashes to the well-known empty digest.
	v = storage.NewVerifyingReader(bytes.NewReader(nil), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
	if _, err := io.ReadAll(v); err != nil {
		t.Fatalf("empty: %v", err)
	}
}

func TestOpenStaging(t *testing.T) {
	drv, _ := filesystem.New(t.TempDir())
	if st, err := storage.OpenStaging("shared", "", drv, newMemSessions(), "n", time.Hour); err != nil || st.Mode() != "shared" {
		t.Fatalf("shared: %v", err)
	}
	if st, err := storage.OpenStaging("local", t.TempDir(), drv, nil, "n", time.Hour); err != nil || st.Mode() != "local" {
		t.Fatalf("local: %v", err)
	}
	if _, err := storage.OpenStaging("shared", "", noObjects{}, newMemSessions(), "n", time.Hour); !errors.Is(err, storage.ErrSharedStagingUnsupported) {
		t.Fatalf("driver without object store: %v", err)
	}
	if _, err := storage.OpenStaging("nfs", "", drv, nil, "n", time.Hour); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

// noObjects is a Driver without ObjectStore support.
type noObjects struct{ storage.Driver }

func (noObjects) Name() string { return "plain" }

func TestValidObjectKey(t *testing.T) {
	for key, want := range map[string]bool{
		"_uploads/abc/0-1234": true,
		"a":                   true,
		"":                    false,
		"/abs":                false,
		"trailing/":           false,
		"a//b":                false,
		"a/../b":              false,
		"./a":                 false,
	} {
		if got := storage.ValidObjectKey(key); got != want {
			t.Errorf("ValidObjectKey(%q) = %v, want %v", key, got, want)
		}
	}
}
