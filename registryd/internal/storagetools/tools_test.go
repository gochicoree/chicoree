package storagetools

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"registryd/internal/storage"
	"registryd/internal/storage/filesystem"
)

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func newFS(t *testing.T) *filesystem.Driver {
	t.Helper()
	d, err := filesystem.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// put stores content under its real digest and returns the row for it.
func put(t *testing.T, d storage.Driver, content string) Blob {
	t.Helper()
	b := Blob{Digest: digestOf([]byte(content)), Size: int64(len(content))}
	if err := d.Put(context.Background(), b.Digest, bytes.NewReader([]byte(content)), b.Size); err != nil {
		t.Fatal(err)
	}
	return b
}

// writeRaw plants bytes at a digest's path without any verification.
func writeRaw(t *testing.T, d *filesystem.Driver, key string, content string) {
	t.Helper()
	p := filepath.Join(d.Root(), filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, d storage.Driver, digest string) string {
	t.Helper()
	rc, _, err := d.Get(context.Background(), digest)
	if err != nil {
		t.Fatalf("get %s: %v", digest, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func rows(blobs ...Blob) BlobSource {
	return func(ctx context.Context, fn func(Blob) error) error {
		for _, b := range blobs {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := fn(b); err != nil {
				return err
			}
		}
		return nil
	}
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestMigrateCopiesVerifiesAndResumes(t *testing.T) {
	src, dst := newFS(t), newFS(t)
	a := put(t, src, "alpha")
	b := put(t, src, "bravo")
	c := put(t, src, "charlie")
	put(t, src, "not in the database") // orphan on the source: must not travel

	rep, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(a, b, c), Workers: 2, Logger: quiet, ProgressEvery: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Complete() || rep.Blobs != 3 || rep.Copied != 3 || rep.Skipped != 0 || rep.CopiedBytes != a.Size+b.Size+c.Size {
		t.Fatalf("first run: %+v", rep)
	}
	for _, blob := range []Blob{a, b, c} {
		if got, err := dst.Stat(context.Background(), blob.Digest); err != nil || got != blob.Size {
			t.Fatalf("target lacks %s: size %d err %v", blob.Digest, got, err)
		}
	}
	if read(t, dst, b.Digest) != "bravo" {
		t.Fatal("content differs")
	}
	if objs, _ := dst.ListObjects(context.Background(), storage.BlobsPrefix); len(objs) != 3 {
		t.Fatalf("target holds %d objects, want 3 (the source orphan must not be copied)", len(objs))
	}

	// A second run finds everything in place.
	rep, err = Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(a, b, c), Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Copied != 0 || rep.Skipped != 3 || rep.SkippedBytes != a.Size+b.Size+c.Size || !rep.Complete() {
		t.Fatalf("second run: %+v", rep)
	}
}

func TestMigrateReportsMissingCorruptAndSizeReplacement(t *testing.T) {
	src, dst := newFS(t), newFS(t)
	good := put(t, src, "good")
	missing := Blob{Digest: digestOf([]byte("never stored")), Size: 12}
	corrupt := Blob{Digest: digestOf([]byte("what the digest says")), Size: 20}
	writeRaw(t, src, storage.BlobPath(corrupt.Digest), "what is really there") // same length, wrong bytes
	resized := put(t, src, "the right content")
	writeRaw(t, dst, storage.BlobPath(resized.Digest), "short") // target holds a stale object of another size

	rep, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(good, missing, corrupt, resized), Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Complete() || rep.Missing != 1 || rep.Corrupt != 1 || rep.Failed != 0 || rep.Copied != 2 || rep.Replaced != 1 {
		t.Fatalf("report: %+v", rep)
	}
	if len(rep.Problems) != 2 {
		t.Fatalf("problems: %+v", rep.Problems)
	}
	if _, err := dst.Stat(context.Background(), corrupt.Digest); err != storage.ErrNotFound {
		t.Fatalf("corrupt blob must not be published on the target, stat err = %v", err)
	}
	if read(t, dst, resized.Digest) != "the right content" {
		t.Fatal("stale target object was not replaced")
	}
}

func TestMigrateDryRunWritesNothing(t *testing.T) {
	src, dst := newFS(t), newFS(t)
	a := put(t, src, "alpha")
	b := put(t, src, "bravo")
	put(t, dst, "bravo")

	rep, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(a, b), DryRun: true, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Copied != 1 || rep.Skipped != 1 || !rep.DryRun || !rep.Complete() {
		t.Fatalf("report: %+v", rep)
	}
	if _, err := dst.Stat(context.Background(), a.Digest); err != storage.ErrNotFound {
		t.Fatal("dry run wrote a blob")
	}
}

func TestMigrateVerifyReplacesCorruptTargetBlob(t *testing.T) {
	src, dst := newFS(t), newFS(t)
	a := put(t, src, "alpha")
	writeRaw(t, dst, storage.BlobPath(a.Digest), "ALPHA") // same size, wrong bytes

	rep, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(a), Logger: quiet})
	if err != nil || rep.Skipped != 1 {
		t.Fatalf("without --verify the size match is trusted: %+v %v", rep, err)
	}
	rep, err = Migrate(context.Background(), MigrateOptions{Source: src, Target: dst, Blobs: rows(a), Verify: true, Logger: quiet})
	if err != nil || rep.Copied != 1 || rep.Replaced != 1 {
		t.Fatalf("with --verify: %+v %v", rep, err)
	}
	if read(t, dst, a.Digest) != "alpha" {
		t.Fatal("target still holds the wrong content")
	}
}

func TestMigrateRefusesSameLocationAndHonoursCancel(t *testing.T) {
	src := newFS(t)
	same, _ := filesystem.New(src.Root())
	if _, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: same, Blobs: rows(), Logger: quiet}); err != ErrSameLocation {
		t.Fatalf("same location: err = %v", err)
	}
	dst := newFS(t)
	a := put(t, src, "alpha")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rep, err := Migrate(ctx, MigrateOptions{Source: src, Target: dst, Blobs: rows(a), Logger: quiet})
	if err != context.Canceled || rep == nil {
		t.Fatalf("cancelled: rep=%v err=%v", rep, err)
	}
}

// plainDriver hides the filesystem driver's ObjectStore, standing in for a
// backend that cannot list.
type plainDriver struct{ storage.Driver }

func TestMigrateWithoutListingFallsBackToStat(t *testing.T) {
	src, dst := newFS(t), newFS(t)
	a := put(t, src, "alpha")
	b := put(t, src, "bravo")
	put(t, dst, "bravo")
	rep, err := Migrate(context.Background(), MigrateOptions{Source: src, Target: plainDriver{dst}, Blobs: rows(a, b), Logger: quiet})
	if err != nil || rep.Copied != 1 || rep.Skipped != 1 {
		t.Fatalf("report: %+v %v", rep, err)
	}
}

func TestVerifyFindsEveryKindOfProblem(t *testing.T) {
	d := newFS(t)
	ok := put(t, d, "fine")
	missing := Blob{Digest: digestOf([]byte("gone")), Size: 4, Unlinked: true}
	wrongSize := put(t, d, "sized")
	wrongSize.Size = 99
	corrupt := Blob{Digest: digestOf([]byte("expected")), Size: 8}
	writeRaw(t, d, storage.BlobPath(corrupt.Digest), "EXPECTED")

	rep, err := Verify(context.Background(), VerifyOptions{Driver: d, Blobs: rows(ok, missing, wrongSize, corrupt), Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	// Without --hash the corrupt blob passes: right size.
	if rep.Clean() || rep.OK != 2 || rep.Missing != 1 || rep.SizeMismatch != 1 || rep.Corrupt != 0 {
		t.Fatalf("without hash: %+v", rep)
	}
	rep, err = Verify(context.Background(), VerifyOptions{Driver: d, Blobs: rows(ok, missing, wrongSize, corrupt), Hash: true, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if rep.OK != 1 || rep.Missing != 1 || rep.SizeMismatch != 1 || rep.Corrupt != 1 || !rep.Hashed || len(rep.Problems) != 3 {
		t.Fatalf("with hash: %+v", rep)
	}
	for _, p := range rep.Problems {
		if p.Kind == "missing" && !strings.Contains(p.Err, "gc run") {
			t.Fatalf("an unlinked missing blob should point at gc: %v", p)
		}
	}
	if rep.OrphansChecked {
		t.Fatal("orphans were not requested")
	}
	// The Stat fallback path answers the same.
	rep, err = Verify(context.Background(), VerifyOptions{Driver: plainDriver{d}, Blobs: rows(ok, missing, wrongSize), Logger: quiet})
	if err != nil || rep.OK != 1 || rep.Missing != 1 || rep.SizeMismatch != 1 {
		t.Fatalf("stat fallback: %+v %v", rep, err)
	}
}

func TestVerifyOrphans(t *testing.T) {
	d := newFS(t)
	known := put(t, d, "known")
	orphan := put(t, d, "orphan")
	writeRaw(t, d, "blobs/sha256/ab/.put-123456", "temp file of a driver")

	rep, err := Verify(context.Background(), VerifyOptions{Driver: d, Blobs: rows(known), Orphans: true, Logger: quiet})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Clean() || !rep.OrphansChecked || rep.Orphans != 1 || rep.OrphanBytes != orphan.Size || rep.Unrecognised != 1 || rep.DeletedOrphans != 0 {
		t.Fatalf("list: %+v", rep)
	}
	if len(rep.OrphanKeys) != 1 || rep.OrphanKeys[0] != storage.BlobPath(orphan.Digest) {
		t.Fatalf("orphan keys: %v", rep.OrphanKeys)
	}

	// Younger than the grace period: kept.
	rep, err = Verify(context.Background(), VerifyOptions{Driver: d, Blobs: rows(known), DeleteOrphans: true, OrphanGrace: time.Hour, Logger: quiet})
	if err != nil || rep.Orphans != 1 || rep.DeletedOrphans != 0 {
		t.Fatalf("grace: %+v %v", rep, err)
	}
	if _, err := d.Stat(context.Background(), orphan.Digest); err != nil {
		t.Fatal("orphan inside the grace period was deleted")
	}
	// Grace elapsed: deleted; the temp file stays.
	rep, err = Verify(context.Background(), VerifyOptions{Driver: d, Blobs: rows(known), DeleteOrphans: true, Logger: quiet})
	if err != nil || rep.DeletedOrphans != 1 || rep.DeletedOrphanBytes != orphan.Size {
		t.Fatalf("delete: %+v %v", rep, err)
	}
	if _, err := d.Stat(context.Background(), orphan.Digest); err != storage.ErrNotFound {
		t.Fatal("orphan was not deleted")
	}
	if _, err := d.Stat(context.Background(), known.Digest); err != nil {
		t.Fatal("known blob was deleted")
	}
	if _, err := os.Stat(filepath.Join(d.Root(), "blobs/sha256/ab/.put-123456")); err != nil {
		t.Fatal("unrecognised object must be left alone")
	}

	if _, err := Verify(context.Background(), VerifyOptions{Driver: plainDriver{d}, Blobs: rows(known), Orphans: true, Logger: quiet}); err != ErrCannotList {
		t.Fatalf("orphans without listing: err = %v", err)
	}
}

func TestFormatBytes(t *testing.T) {
	for n, want := range map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KiB", 1536: "1.5 KiB", 5 << 30: "5.0 GiB"} {
		if got := FormatBytes(n); got != want {
			t.Errorf("FormatBytes(%d) = %q, want %q", n, got, want)
		}
	}
}
