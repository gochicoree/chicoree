// Package storagetools holds the operator tools that treat the blob tree as
// a whole: migrating it to another backend and verifying it against the
// database. Both walk the blobs table — what the registry believes exists —
// rather than the backend, so garbage never travels and every row the
// backend cannot serve is reported. They are run as `registryd storage
// migrate` and `registryd storage verify`.
package storagetools

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"registryd/internal/storage"
)

// Blob is one row of the blobs table. Unlinked is set when no repository
// references it any more (gc will drop the row; until then a push of the
// digest is deduplicated against it, so its content still matters).
type Blob struct {
	Digest   string
	Size     int64
	Unlinked bool
}

// missingErr explains a missing blob: for an unlinked row the fix is a gc
// run, not a restore.
func missingErr(b Blob) error {
	if b.Unlinked {
		return errors.New("no repository references it; a gc run removes the row")
	}
	return nil
}

// BlobSource streams blob rows to fn (see store.ListBlobs).
type BlobSource func(ctx context.Context, fn func(Blob) error) error

// Problem is one blob or object a tool could not handle. Kind is one of
// "missing" (the backend has no such blob), "corrupt" (its content does not
// hash to the digest), "size" (the backend's size differs from the row) or
// "failed" (a read or write error).
type Problem struct {
	Digest string
	Kind   string
	Err    string
}

func (p Problem) String() string {
	if p.Err == "" {
		return p.Digest + ": " + p.Kind
	}
	return p.Digest + ": " + p.Kind + " (" + p.Err + ")"
}

// maxProblems caps the problems kept in a report; every one is also logged
// as it happens.
const maxProblems = 100

const defaultWorkers = 4

// walk streams blobs from src to workers goroutines running fn, stopping
// early when ctx ends. The source's error (including ctx.Err()) is returned.
func walk(ctx context.Context, src BlobSource, workers int, fn func(context.Context, Blob)) error {
	if workers <= 0 {
		workers = defaultWorkers
	}
	jobs := make(chan Blob, workers*2)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for b := range jobs {
				if ctx.Err() != nil {
					continue // drain; the source stops on its own
				}
				fn(ctx, b)
			}
		}()
	}
	err := src(ctx, func(b Blob) error {
		select {
		case jobs <- b:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	close(jobs)
	wg.Wait()
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	return err
}

// progress runs fn every interval until stop is closed, then once more.
func progress(interval time.Duration, fn func()) (stop func()) {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				fn()
			case <-done:
				return
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

// inventory is the backend's blob tree as one listing, keyed by digest, for
// backends that can list objects. It makes existence and size checks free
// and is what orphan detection compares the database against.
type inventory struct {
	byDigest     map[string]storage.ObjectInfo
	unrecognised []string // keys under blobs/ that are not blob paths
}

// listBlobs takes an inventory when the driver is an ObjectStore. A driver
// that cannot list, or a listing that fails, yields nil so callers fall
// back to Stat per blob.
func listBlobs(ctx context.Context, d storage.Driver, log *slog.Logger) (*inventory, error) {
	lister, ok := d.(storage.ObjectStore)
	if !ok {
		return nil, nil
	}
	objects, err := lister.ListObjects(ctx, storage.BlobsPrefix)
	if err != nil {
		return nil, err
	}
	inv := &inventory{byDigest: make(map[string]storage.ObjectInfo, len(objects))}
	for _, o := range objects {
		digest, ok := storage.DigestFromPath(o.Key)
		if !ok {
			inv.unrecognised = append(inv.unrecognised, o.Key)
			continue
		}
		inv.byDigest[digest] = o
	}
	log.Info("listed blob tree", "backend", storage.Describe(d), "objects", len(inv.byDigest), "other", len(inv.unrecognised))
	return inv, nil
}

// stat reports whether the backend holds the blob and how big it is, from
// the inventory when there is one — with a Stat behind a miss, because a
// blob written after the listing was taken is not an absent blob.
func stat(ctx context.Context, d storage.Driver, inv *inventory, digest string) (size int64, found bool, err error) {
	if inv != nil {
		if o, ok := inv.byDigest[digest]; ok {
			return o.Size, true, nil
		}
	}
	size, err = d.Stat(ctx, digest)
	if err == storage.ErrNotFound {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return size, true, nil
}

// supportedDigest reports whether the tools can verify content against the
// digest; uploads only ever commit sha256, so anything else is a foreign row.
func supportedDigest(digest string) bool { return strings.HasPrefix(digest, "sha256:") }

// FormatBytes renders a byte count for log lines ("12.3 GiB").
func FormatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 5; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
