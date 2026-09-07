package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"registryd/internal/storage"
	"registryd/internal/storagetools"
	"registryd/internal/store"
)

const storageUsage = `Usage: registryd storage <command> [flags]

Tools that work on the blob tree as a whole. Both read the same DATABASE_URL
and STORAGE_DRIVER (+ <NAME>_* options) registryd serves with; the new
backend is described by TARGET_STORAGE_DRIVER and TARGET_<NAME>_* variables.

  migrate   copy every blob the database knows to the target backend
  verify    check that the backend holds every blob the database knows

Run "registryd storage <command> -h" for the flags of a command, and
"registryd plugins" for the options of every backend.
`

func runStorage(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, storageUsage)
		return 2
	}
	switch args[0] {
	case "migrate":
		return runStorageMigrate(args[1:])
	case "verify":
		return runStorageVerify(args[1:])
	case "help", "-h", "--help":
		fmt.Fprint(os.Stdout, storageUsage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "registryd storage: unknown command %q\n\n%s", args[0], storageUsage)
	return 2
}

// toolContext ends on Ctrl-C / SIGTERM so a long copy stops cleanly and
// reports what it did; a second run resumes.
func toolContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// openStore connects with DATABASE_URL, waiting briefly for the schema.
func openStore(ctx context.Context) (*store.Store, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, errors.New("DATABASE_URL is required")
	}
	st, err := store.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := st.WaitForSchema(ctx, 10*time.Second); err != nil {
		st.Close()
		return nil, err
	}
	return st, nil
}

// openConfigured opens the backend registryd serves from. With override
// set, that driver is used instead and its options may come from
// SOURCE_<NAME>_* as well as <NAME>_*.
func openConfigured(ctx context.Context, override string) (storage.Driver, error) {
	name := override
	if name == "" {
		name = os.Getenv("SOURCE_STORAGE_DRIVER")
	}
	if name == "" {
		name = os.Getenv("STORAGE_DRIVER")
	}
	if name == "" {
		name = "filesystem"
	}
	opts := storage.LayeredOptions{storage.NewPrefixedEnvOptions("SOURCE_", name), storage.NewEnvOptions(name)}
	return storage.Open(ctx, name, opts)
}

// openTarget opens the backend described by TARGET_STORAGE_DRIVER (or the
// given name) and TARGET_<NAME>_*.
func openTarget(ctx context.Context, name string) (storage.Driver, error) {
	if name == "" {
		name = os.Getenv("TARGET_STORAGE_DRIVER")
	}
	if name == "" {
		return nil, errors.New("no target backend: pass --to <driver> or set TARGET_STORAGE_DRIVER")
	}
	return storage.Open(ctx, name, storage.NewPrefixedEnvOptions("TARGET_", name))
}

func blobSource(st *store.Store) storagetools.BlobSource {
	return func(ctx context.Context, fn func(storagetools.Blob) error) error {
		return st.ListBlobs(ctx, func(b store.Blob) error {
			return fn(storagetools.Blob{Digest: b.Digest, Size: b.Size, Unlinked: !b.Linked})
		})
	}
}

func fail(err error) int {
	fmt.Fprintln(os.Stderr, "registryd storage:", err)
	return 1
}

func printProblems(problems []storagetools.Problem, total int64) {
	if len(problems) == 0 {
		return
	}
	if int64(len(problems)) < total {
		fmt.Printf("First %d of %d problems (every one is in the log):\n", len(problems), total)
	} else {
		fmt.Println("Problems:")
	}
	for _, p := range problems {
		fmt.Println("  " + p.String())
	}
}

func runStorageMigrate(args []string) int {
	fs := flag.NewFlagSet("registryd storage migrate", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	to := fs.String("to", "", "target storage driver; its options come from TARGET_<NAME>_* (default: TARGET_STORAGE_DRIVER)")
	from := fs.String("from", "", "source driver when it is not the configured one; options from SOURCE_<NAME>_*, then <NAME>_*")
	workers := fs.Int("workers", 4, "blobs copied concurrently")
	dryRun := fs.Bool("dry-run", false, "only count what would be copied; reads and writes nothing")
	verify := fs.Bool("verify", false, "re-read blobs the target already holds and replace any whose content does not match")
	every := fs.Duration("progress", 10*time.Second, "how often a progress line is logged")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: registryd storage migrate --to <driver> [flags]

Copies every blob the database knows from the configured backend to the
target, hashing each one on the way; blobs the target already holds are
skipped, so running it again resumes and picks up what was pushed since.
Exit status 1 when a blob is missing or corrupt on the source or a copy
failed — do not switch STORAGE_DRIVER until a run ends with status 0.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	log := newLogger(os.Getenv("REGISTRY_LOG_FORMAT"), os.Stderr)

	ctx, stop := toolContext()
	defer stop()
	st, err := openStore(ctx)
	if err != nil {
		return fail(err)
	}
	defer st.Close()
	source, err := openConfigured(ctx, *from)
	if err != nil {
		return fail(fmt.Errorf("source backend: %w", err))
	}
	target, err := openTarget(ctx, *to)
	if err != nil {
		return fail(fmt.Errorf("target backend: %w", err))
	}
	count, bytes, err := st.BlobStats(ctx)
	if err != nil {
		return fail(fmt.Errorf("count blobs: %w", err))
	}

	rep, err := storagetools.Migrate(ctx, storagetools.MigrateOptions{
		Source: source, Target: target, Blobs: blobSource(st),
		Workers: *workers, DryRun: *dryRun, Verify: *verify,
		Logger: log, ProgressEvery: *every, ExpectedCount: count, ExpectedBytes: bytes,
	})
	if err != nil && rep == nil {
		return fail(err)
	}
	heading := "Migration"
	if rep.DryRun {
		heading = "Dry run"
	}
	switch {
	case err != nil:
		fmt.Printf("%s interrupted: %s\n", heading, rep.Summary())
		printProblems(rep.Problems, rep.Missing+rep.Corrupt+rep.Failed)
		fmt.Println("Run the same command again to resume.")
		return 1
	case !rep.Complete():
		fmt.Printf("%s finished with problems: %s\n", heading, rep.Summary())
		printProblems(rep.Problems, rep.Missing+rep.Corrupt+rep.Failed)
		fmt.Println("The target does not hold every blob the database knows; do not switch STORAGE_DRIVER yet.")
		return 1
	case rep.DryRun:
		fmt.Printf("Dry run: %s\n", rep.Summary())
	default:
		fmt.Printf("Migration complete: %s\n", rep.Summary())
		fmt.Printf("%s now holds every blob the database knows. Stop pushes, run this once more to pick up anything pushed meanwhile, then switch STORAGE_DRIVER.\n", storage.Describe(target))
	}
	return 0
}

func runStorageVerify(args []string) int {
	fs := flag.NewFlagSet("registryd storage verify", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	useTarget := fs.Bool("target", false, "check the backend described by TARGET_STORAGE_DRIVER / TARGET_<NAME>_* instead of the configured one")
	hash := fs.Bool("hash", false, "read every blob back and compare its digest (slow: reads the whole tree)")
	orphans := fs.Bool("orphans", false, "list objects in the blob tree that no blob row references")
	deleteOrphans := fs.Bool("delete-orphans", false, "delete orphaned objects older than --grace (implies --orphans)")
	grace := fs.Duration("grace", time.Hour, "leave orphaned objects younger than this alone (a push may still be registering them)")
	workers := fs.Int("workers", 4, "blobs checked concurrently")
	every := fs.Duration("progress", 10*time.Second, "how often a progress line is logged")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: registryd storage verify [flags]

Checks that the storage backend holds every blob the database knows, with
the size the row records and, with --hash, the right content. --orphans
lists objects in the blob tree that no row references (left over from a
restored database or an interrupted push); --delete-orphans removes them
once they are older than --grace. Exit status 1 when a blob is missing,
has the wrong size or is corrupt.

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	log := newLogger(os.Getenv("REGISTRY_LOG_FORMAT"), os.Stderr)

	ctx, stop := toolContext()
	defer stop()
	st, err := openStore(ctx)
	if err != nil {
		return fail(err)
	}
	defer st.Close()
	var driver storage.Driver
	if *useTarget {
		driver, err = openTarget(ctx, "")
	} else {
		driver, err = openConfigured(ctx, "")
	}
	if err != nil {
		return fail(fmt.Errorf("storage backend: %w", err))
	}
	count, bytes, err := st.BlobStats(ctx)
	if err != nil {
		return fail(fmt.Errorf("count blobs: %w", err))
	}

	rep, err := storagetools.Verify(ctx, storagetools.VerifyOptions{
		Driver: driver, Blobs: blobSource(st),
		Workers: *workers, Hash: *hash, Orphans: *orphans || *deleteOrphans, DeleteOrphans: *deleteOrphans, OrphanGrace: *grace,
		Logger: log, ProgressEvery: *every, ExpectedCount: count, ExpectedBytes: bytes,
	})
	if err != nil && rep == nil {
		return fail(err)
	}
	problems := rep.Missing + rep.SizeMismatch + rep.Corrupt + rep.Failed
	switch {
	case err != nil:
		fmt.Printf("Verification interrupted: %s\n", rep.Summary())
		printProblems(rep.Problems, problems)
		return 1
	case !rep.Clean():
		fmt.Printf("Verification found problems on %s: %s\n", storage.Describe(driver), rep.Summary())
		printProblems(rep.Problems, problems)
		return 1
	}
	fmt.Printf("Verification passed on %s: %s\n", storage.Describe(driver), rep.Summary())
	if rep.OrphansChecked && rep.Orphans > 0 && !*deleteOrphans {
		fmt.Printf("Orphaned objects can be removed with --delete-orphans once they are older than --grace.\n")
	}
	return 0
}

// newLogger builds the text or JSON logger both the server and the tools use.
func newLogger(format string, w io.Writer) *slog.Logger {
	var handler slog.Handler = slog.NewTextHandler(w, nil)
	if format == "json" {
		handler = slog.NewJSONHandler(w, nil)
	}
	return slog.New(handler)
}
