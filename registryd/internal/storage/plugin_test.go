package storage

import (
	"context"
	"io"
	"testing"
)

type fakeDriver struct{ name string }

func (f fakeDriver) Get(context.Context, string) (io.ReadCloser, int64, error) {
	return nil, 0, ErrNotFound
}
func (f fakeDriver) Stat(context.Context, string) (int64, error)         { return 0, ErrNotFound }
func (f fakeDriver) Put(context.Context, string, io.Reader, int64) error { return nil }
func (f fakeDriver) Delete(context.Context, string) error                { return nil }
func (f fakeDriver) RedirectURL(context.Context, string) (string, error) { return "", nil }
func (f fakeDriver) Name() string                                        { return f.name }

func TestRegisterAndOpen(t *testing.T) {
	Register(&Plugin{
		Name:    "fake-test",
		Options: []OptionDoc{{Key: "BUCKET", Required: true}},
		New: func(_ context.Context, o Options) (Driver, error) {
			return fakeDriver{name: "fake:" + Get(o, "BUCKET", "")}, nil
		},
	})

	if _, err := Open(context.Background(), "fake-test", MapOptions{}); err == nil {
		t.Fatal("expected error for missing required option")
	}
	d, err := Open(context.Background(), "fake-test", MapOptions{"BUCKET": "b1"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Name() != "fake:b1" {
		t.Fatalf("unexpected driver name %q", d.Name())
	}
	if _, err := Open(context.Background(), "nope", MapOptions{}); err == nil {
		t.Fatal("expected error for unknown plugin")
	}
}

func TestEnvOptions(t *testing.T) {
	t.Setenv("FAKE_ENV_ENDPOINT", "a")
	t.Setenv("STORAGE_FAKE_ENV_BUCKET", "b")
	o := NewEnvOptions("fake-env")
	if v, _ := o.Lookup("ENDPOINT"); v != "a" {
		t.Fatalf("canonical lookup failed: %q", v)
	}
	if v, _ := o.Lookup("BUCKET"); v != "b" {
		t.Fatalf("STORAGE_ prefixed lookup failed: %q", v)
	}
	if EnvName("bunny", "access_key") != "BUNNY_ACCESS_KEY" {
		t.Fatal("EnvName")
	}
}

func TestBlobPath(t *testing.T) {
	if got := BlobPath("sha256:abcdef"); got != "blobs/sha256/ab/abcdef" {
		t.Fatalf("got %q", got)
	}
}
