package storagetools

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"registryd/internal/storage"
)

// VerifyOptions configures Verify.
type VerifyOptions struct {
	Driver storage.Driver
	Blobs  BlobSource
	// Workers checks run concurrently (default 4).
	Workers int
	// Hash reads every blob back and compares its digest; without it only
	// existence and size are checked.
	Hash bool
	// Orphans lists objects in the blob tree that no row references; needs
	// a backend that can list objects.
	Orphans bool
	// DeleteOrphans removes orphans older than OrphanGrace. Objects whose
	// age the backend does not report are never deleted.
	DeleteOrphans bool
	OrphanGrace   time.Duration
	Logger        *slog.Logger
	ProgressEvery time.Duration
	ExpectedCount int64
	ExpectedBytes int64
}

// ErrCannotList is returned when orphan detection is asked of a backend
// that cannot enumerate its objects.
var ErrCannotList = errors.New("this storage backend cannot list its objects")

// VerifyReport is the outcome of a Verify run. Clean() says whether the
// backend can serve every blob the database knows.
type VerifyReport struct {
	Blobs        int64 // rows seen
	Bytes        int64
	OK           int64
	Missing      int64
	SizeMismatch int64
	Corrupt      int64 // content does not hash to the digest (Hash only)
	Failed       int64 // read errors
	Hashed       bool
	Problems     []Problem

	// Orphan figures are only filled when Orphans was requested.
	OrphansChecked     bool
	Orphans            int64
	OrphanBytes        int64
	DeletedOrphans     int64
	DeletedOrphanBytes int64
	// Unrecognised counts objects under blobs/ that are not blob paths
	// (a driver's temporary files, foreign objects); they are left alone.
	Unrecognised int64
	OrphanKeys   []string // the first orphans, for the terminal
}

// Clean reports whether every blob row is served by the backend.
func (r *VerifyReport) Clean() bool {
	return r.Missing == 0 && r.SizeMismatch == 0 && r.Corrupt == 0 && r.Failed == 0
}

// Summary is a one-line account for logs and the terminal.
func (r *VerifyReport) Summary() string {
	check := "present with the right size"
	if r.Hashed {
		check = "present and hash to their digest"
	}
	s := fmt.Sprintf("%d blobs (%s): %d %s, %d missing, %d wrong size, %d corrupt, %d unreadable",
		r.Blobs, FormatBytes(r.Bytes), r.OK, check, r.Missing, r.SizeMismatch, r.Corrupt, r.Failed)
	if r.OrphansChecked {
		s += fmt.Sprintf("; %d orphaned objects (%s), %d deleted (%s), %d unrecognised objects",
			r.Orphans, FormatBytes(r.OrphanBytes), r.DeletedOrphans, FormatBytes(r.DeletedOrphanBytes), r.Unrecognised)
	}
	return s
}

type verifier struct {
	opts VerifyOptions
	log  *slog.Logger
	inv  *inventory

	mu     sync.Mutex
	report VerifyReport
	seen   map[string]struct{}
}

// Verify checks that the backend holds every blob the database knows, with
// the row's size and — with Hash — the right content, and optionally finds
// objects in the blob tree that no row references. The report is returned
// even when ctx ends early, alongside ctx.Err().
func Verify(ctx context.Context, opts VerifyOptions) (*VerifyReport, error) {
	if opts.Driver == nil || opts.Blobs == nil {
		return nil, errors.New("verify: driver and blobs are required")
	}
	v := &verifier{opts: opts, log: opts.Logger, seen: map[string]struct{}{}}
	if v.log == nil {
		v.log = slog.Default()
	}
	v.report.Hashed = opts.Hash
	wantOrphans := opts.Orphans || opts.DeleteOrphans

	inv, err := listBlobs(ctx, opts.Driver, v.log)
	if err != nil {
		if wantOrphans {
			return nil, fmt.Errorf("list blob tree: %w", err)
		}
		v.log.Warn("could not list the blob tree; checking blobs one by one", "err", err)
	}
	if inv == nil && wantOrphans {
		return nil, ErrCannotList
	}
	v.inv = inv

	v.log.Info("verification starting", "backend", storage.Describe(opts.Driver), "blobs", opts.ExpectedCount,
		"bytes", FormatBytes(opts.ExpectedBytes), "workers", max(opts.Workers, 1), "hash", opts.Hash, "orphans", wantOrphans)
	stop := progress(opts.ProgressEvery, v.logProgress)
	walkErr := walk(ctx, opts.Blobs, opts.Workers, v.process)
	stop()
	if walkErr == nil && wantOrphans {
		v.orphans(ctx)
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	rep := v.report
	return &rep, walkErr
}

func (v *verifier) logProgress() {
	v.mu.Lock()
	r := v.report
	v.mu.Unlock()
	attrs := []any{"seen", r.Blobs, "ok", r.OK, "missing", r.Missing, "wrongSize", r.SizeMismatch, "corrupt", r.Corrupt, "failed", r.Failed}
	if v.opts.ExpectedCount > 0 {
		attrs = append(attrs, "of", v.opts.ExpectedCount)
	}
	v.log.Info("verification progress", attrs...)
}

func (v *verifier) problem(b Blob, kind string, err error) {
	p := Problem{Digest: b.Digest, Kind: kind}
	if err != nil {
		p.Err = err.Error()
	}
	v.log.Warn("blob check failed", "digest", b.Digest, "kind", kind, "err", p.Err)
	v.mu.Lock()
	defer v.mu.Unlock()
	switch kind {
	case "missing":
		v.report.Missing++
	case "size":
		v.report.SizeMismatch++
	case "corrupt":
		v.report.Corrupt++
	default:
		v.report.Failed++
	}
	if len(v.report.Problems) < maxProblems {
		v.report.Problems = append(v.report.Problems, p)
	}
}

func (v *verifier) process(ctx context.Context, b Blob) {
	v.mu.Lock()
	v.report.Blobs++
	v.report.Bytes += b.Size
	v.seen[b.Digest] = struct{}{}
	v.mu.Unlock()

	size, found, err := stat(ctx, v.opts.Driver, v.inv, b.Digest)
	if err != nil {
		v.problem(b, "failed", err)
		return
	}
	if !found {
		v.problem(b, "missing", missingErr(b))
		return
	}
	if size != b.Size {
		v.problem(b, "size", fmt.Errorf("stored %d bytes, database says %d", size, b.Size))
		return
	}
	if v.opts.Hash {
		if !supportedDigest(b.Digest) {
			v.problem(b, "failed", errors.New("unsupported digest algorithm"))
			return
		}
		ok, err := hashMatches(ctx, v.opts.Driver, b.Digest)
		if err != nil {
			v.problem(b, "failed", err)
			return
		}
		if !ok {
			v.problem(b, "corrupt", nil)
			return
		}
	}
	v.mu.Lock()
	v.report.OK++
	v.mu.Unlock()
}

// orphans compares the listing against the rows seen and, when asked,
// deletes objects that have been orphaned for longer than the grace period.
func (v *verifier) orphans(ctx context.Context) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.report.OrphansChecked = true
	v.report.Unrecognised = int64(len(v.inv.unrecognised))
	for _, key := range v.inv.unrecognised {
		v.log.Info("object in the blob tree is not a blob; left alone", "key", key)
	}
	store, _ := v.opts.Driver.(storage.ObjectStore)
	grace := v.opts.OrphanGrace
	ageUnknown := 0
	for digest, o := range v.inv.byDigest {
		if _, ok := v.seen[digest]; ok {
			continue
		}
		v.report.Orphans++
		v.report.OrphanBytes += o.Size
		if len(v.report.OrphanKeys) < maxProblems {
			v.report.OrphanKeys = append(v.report.OrphanKeys, o.Key)
		}
		if !v.opts.DeleteOrphans {
			v.log.Info("orphaned object", "key", o.Key, "bytes", o.Size, "modified", o.ModTime)
			continue
		}
		if o.ModTime.IsZero() {
			ageUnknown++
			continue
		}
		if age := time.Since(o.ModTime); age < grace {
			v.log.Info("orphaned object younger than the grace period; kept", "key", o.Key, "age", age.Round(time.Second))
			continue
		}
		if err := store.DeleteObject(ctx, o.Key); err != nil {
			v.log.Warn("orphan delete failed", "key", o.Key, "err", err)
			continue
		}
		v.log.Info("deleted orphaned object", "key", o.Key, "bytes", o.Size)
		v.report.DeletedOrphans++
		v.report.DeletedOrphanBytes += o.Size
	}
	if ageUnknown > 0 {
		v.log.Warn("orphans of unknown age were kept: the backend does not report modification times", "count", ageUnknown)
	}
}
