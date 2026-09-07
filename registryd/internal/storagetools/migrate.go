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

// MigrateOptions configures Migrate.
type MigrateOptions struct {
	Source storage.Driver
	Target storage.Driver
	Blobs  BlobSource
	// Workers copies run concurrently (default 4).
	Workers int
	// DryRun counts what would be copied without reading or writing blobs.
	DryRun bool
	// Verify re-reads blobs the target already holds and replaces any
	// whose content does not hash to its digest; without it a blob of the
	// right size is trusted.
	Verify bool
	Logger *slog.Logger
	// ProgressEvery is how often a progress line is logged (default 10s).
	ProgressEvery time.Duration
	// ExpectedCount and ExpectedBytes, when known, make the progress lines
	// say how far along the run is.
	ExpectedCount int64
	ExpectedBytes int64
}

// MigrateReport is the outcome of a Migrate run. Complete() says whether
// the target now holds every blob the database knows.
type MigrateReport struct {
	Blobs        int64 // rows seen
	Bytes        int64 // their size per the database
	Copied       int64 // written to the target this run (or would be, in a dry run)
	CopiedBytes  int64
	Replaced     int64 // of Copied: the target had an object of another size or content
	Skipped      int64 // already on the target
	SkippedBytes int64
	Missing      int64 // the source has no such blob
	Corrupt      int64 // the source's content does not hash to the digest
	Failed       int64 // read or write errors
	Problems     []Problem
	DryRun       bool
}

// Complete reports whether every blob is on the target (after a dry run:
// whether every blob could be copied).
func (r *MigrateReport) Complete() bool {
	return r.Missing == 0 && r.Corrupt == 0 && r.Failed == 0
}

// Summary is a one-line account for logs and the terminal.
func (r *MigrateReport) Summary() string {
	verb := "copied"
	if r.DryRun {
		verb = "to copy"
	}
	return fmt.Sprintf("%d blobs (%s): %d %s (%s, %d replaced), %d already there (%s), %d missing on source, %d corrupt, %d failed",
		r.Blobs, FormatBytes(r.Bytes), r.Copied, verb, FormatBytes(r.CopiedBytes), r.Replaced,
		r.Skipped, FormatBytes(r.SkippedBytes), r.Missing, r.Corrupt, r.Failed)
}

// ErrSameLocation is returned when source and target are the same backend.
var ErrSameLocation = errors.New("source and target are the same storage location")

type migrator struct {
	opts MigrateOptions
	log  *slog.Logger
	inv  *inventory

	mu     sync.Mutex
	report MigrateReport
}

// Migrate copies every blob the database knows from the source backend to
// the target. Content is hashed while it streams, so a blob whose bytes do
// not match its digest is reported instead of published; blobs the target
// already holds are skipped, which makes a second run resume the first.
// The report is returned even when ctx ends early, alongside ctx.Err().
func Migrate(ctx context.Context, opts MigrateOptions) (*MigrateReport, error) {
	if opts.Source == nil || opts.Target == nil || opts.Blobs == nil {
		return nil, errors.New("migrate: source, target and blobs are required")
	}
	if opts.Source.Name() == opts.Target.Name() && storage.Describe(opts.Source) == storage.Describe(opts.Target) {
		return nil, ErrSameLocation
	}
	m := &migrator{opts: opts, log: opts.Logger}
	if m.log == nil {
		m.log = slog.Default()
	}
	m.report.DryRun = opts.DryRun

	inv, err := listBlobs(ctx, opts.Target, m.log)
	if err != nil {
		m.log.Warn("could not list the target's blob tree; checking blobs one by one", "err", err)
	}
	m.inv = inv

	m.log.Info("migration starting", "from", storage.Describe(opts.Source), "to", storage.Describe(opts.Target),
		"blobs", opts.ExpectedCount, "bytes", FormatBytes(opts.ExpectedBytes), "workers", max(opts.Workers, 1), "dryRun", opts.DryRun, "verify", opts.Verify)
	stop := progress(opts.ProgressEvery, m.logProgress)
	walkErr := walk(ctx, opts.Blobs, opts.Workers, m.process)
	stop()

	m.mu.Lock()
	defer m.mu.Unlock()
	rep := m.report
	return &rep, walkErr
}

func (m *migrator) logProgress() {
	m.mu.Lock()
	r := m.report
	m.mu.Unlock()
	attrs := []any{"seen", r.Blobs, "copied", r.Copied, "copiedBytes", FormatBytes(r.CopiedBytes),
		"skipped", r.Skipped, "missing", r.Missing, "corrupt", r.Corrupt, "failed", r.Failed}
	if m.opts.ExpectedCount > 0 {
		attrs = append(attrs, "of", m.opts.ExpectedCount)
	}
	if m.opts.ExpectedBytes > 0 {
		attrs = append(attrs, "ofBytes", FormatBytes(m.opts.ExpectedBytes))
	}
	m.log.Info("migration progress", attrs...)
}

func (m *migrator) problem(b Blob, kind string, err error) {
	p := Problem{Digest: b.Digest, Kind: kind}
	if err != nil {
		p.Err = err.Error()
	}
	m.log.Warn("blob not migrated", "digest", b.Digest, "kind", kind, "err", p.Err)
	m.mu.Lock()
	defer m.mu.Unlock()
	switch kind {
	case "missing":
		m.report.Missing++
	case "corrupt":
		m.report.Corrupt++
	default:
		m.report.Failed++
	}
	if len(m.report.Problems) < maxProblems {
		m.report.Problems = append(m.report.Problems, p)
	}
}

func (m *migrator) process(ctx context.Context, b Blob) {
	m.mu.Lock()
	m.report.Blobs++
	m.report.Bytes += b.Size
	m.mu.Unlock()

	if !supportedDigest(b.Digest) {
		m.problem(b, "failed", errors.New("unsupported digest algorithm"))
		return
	}

	size, found, err := stat(ctx, m.opts.Target, m.inv, b.Digest)
	if err != nil {
		m.problem(b, "failed", fmt.Errorf("target: %w", err))
		return
	}
	replace := false
	if found {
		switch {
		case size != b.Size:
			m.log.Warn("target holds the blob with another size; replacing", "digest", b.Digest, "target", size, "database", b.Size)
		case !m.opts.Verify:
			m.skip(b)
			return
		default:
			ok, err := hashMatches(ctx, m.opts.Target, b.Digest)
			if err != nil {
				m.problem(b, "failed", fmt.Errorf("target: %w", err))
				return
			}
			if ok {
				m.skip(b)
				return
			}
			m.log.Warn("target blob does not hash to its digest; replacing", "digest", b.Digest)
		}
		replace = true
	}

	if m.opts.DryRun {
		m.copied(b.Size, replace)
		return
	}
	rc, srcSize, err := m.opts.Source.Get(ctx, b.Digest)
	if errors.Is(err, storage.ErrNotFound) {
		m.problem(b, "missing", missingErr(b))
		return
	}
	if err != nil {
		m.problem(b, "failed", fmt.Errorf("source: %w", err))
		return
	}
	defer rc.Close()
	if srcSize != b.Size {
		m.log.Warn("stored size differs from the database row", "digest", b.Digest, "stored", srcSize, "database", b.Size)
	}
	// Put publishes nothing until the reader ended cleanly, and the
	// verifying reader turns a hash mismatch into that final error.
	if err := m.opts.Target.Put(ctx, b.Digest, storage.NewVerifyingReader(rc, b.Digest), srcSize); err != nil {
		if errors.Is(err, storage.ErrDigestMismatch) {
			m.problem(b, "corrupt", err)
			return
		}
		m.problem(b, "failed", fmt.Errorf("copy: %w", err))
		return
	}
	m.copied(srcSize, replace)
}

func (m *migrator) skip(b Blob) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.report.Skipped++
	m.report.SkippedBytes += b.Size
}

func (m *migrator) copied(size int64, replaced bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.report.Copied++
	m.report.CopiedBytes += size
	if replaced {
		m.report.Replaced++
	}
}

// hashMatches reads a blob back from the driver and compares its digest.
func hashMatches(ctx context.Context, d storage.Driver, digest string) (bool, error) {
	rc, _, err := d.Get(ctx, digest)
	if err != nil {
		return false, err
	}
	defer rc.Close()
	actual, _, err := storage.DigestOf(rc)
	if err != nil {
		return false, err
	}
	return actual == digest, nil
}
