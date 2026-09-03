package upstream

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeRegistry is a minimal distribution API behind a Bearer challenge: /v2/,
// one manifest under two references, one blob. It counts requests so tests
// can assert how often the upstream was contacted.
type fakeRegistry struct {
	srv       *httptest.Server
	manifest  []byte
	digest    string
	blob      []byte
	blobDig   string
	tokenHits atomic.Int32
	hits      atomic.Int32
	// requireUser/requirePass, when set, must be presented to the token endpoint.
	requireUser, requirePass string
	// rateLimited makes every manifest request answer 429.
	rateLimited atomic.Bool
	// noHeadDigest omits Docker-Content-Digest on HEAD (like some registries).
	noHeadDigest bool
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{
		manifest: []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","size":2},"layers":[]}`),
		blob:     []byte("hello layer bytes"),
	}
	f.digest = digestOf(f.manifest)
	f.blobDig = digestOf(f.blob)
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		f.tokenHits.Add(1)
		if f.requireUser != "" {
			u, p, ok := r.BasicAuth()
			if !ok || u != f.requireUser || p != f.requirePass {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
		fmt.Fprintf(w, `{"token":"tok-%s","expires_in":300}`, r.URL.Query().Get("scope"))
	})
	mux.HandleFunc("/v2/", func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer tok-") {
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fake",scope="repository:library/alpine:pull"`, f.srv.URL))
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}`)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/v2/")
		switch {
		case path == "":
			fmt.Fprint(w, "{}")
		case path == "library/alpine/manifests/latest" || path == "library/alpine/manifests/"+f.digest:
			if f.rateLimited.Load() {
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprint(w, `{"errors":[{"code":"TOOMANYREQUESTS","message":"pull rate limit"}]}`)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			if r.Method != http.MethodHead || !f.noHeadDigest {
				w.Header().Set("Docker-Content-Digest", f.digest)
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(f.manifest)))
			if r.Method == http.MethodHead {
				return
			}
			_, _ = w.Write(f.manifest)
		case path == "library/alpine/blobs/"+f.blobDig:
			// Real registries redirect blobs to a CDN; emulate that once.
			if r.URL.Query().Get("cdn") == "" {
				http.Redirect(w, r, r.URL.Path+"?cdn=1", http.StatusTemporaryRedirect)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(f.blob)))
			_, _ = w.Write(f.blob)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}`)
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func TestClientBearerFlow(t *testing.T) {
	f := newFakeRegistry(t)
	c := NewClient(f.srv.URL, "", "")
	var logged atomic.Int32
	c.OnRequest = func(method, url string) { logged.Add(1) }
	ctx := context.Background()

	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	head, err := c.HeadManifest(ctx, "library/alpine", "latest")
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.Digest != f.digest || head.MediaType != "application/vnd.oci.image.manifest.v1+json" {
		t.Fatalf("head = %+v", head)
	}
	m, err := c.GetManifest(ctx, "library/alpine", "latest")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if m.Digest != f.digest || string(m.Payload) != string(f.manifest) {
		t.Fatalf("manifest = %+v", m)
	}
	if _, err := c.GetManifest(ctx, "library/alpine", f.digest); err != nil {
		t.Fatalf("get by digest: %v", err)
	}
	body, size, err := c.OpenBlob(ctx, "library/alpine", f.blobDig)
	if err != nil {
		t.Fatalf("blob: %v", err)
	}
	data, _ := io.ReadAll(body)
	body.Close()
	if size != int64(len(f.blob)) || string(data) != string(f.blob) {
		t.Fatalf("blob = %d bytes %q", size, data)
	}

	// The /v2/ ping fetches a token for the empty scope, the repository
	// requests share a second one — never one per request.
	if got := f.tokenHits.Load(); got != 2 {
		t.Fatalf("token endpoint hit %d times, want 2", got)
	}
	if logged.Load() == 0 {
		t.Fatal("OnRequest was never called")
	}

	if _, err := c.GetManifest(ctx, "library/alpine", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing tag: err = %v, want ErrNotFound", err)
	}
	f.rateLimited.Store(true)
	if _, err := c.HeadManifest(ctx, "library/alpine", "latest"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate limited: err = %v, want ErrRateLimited", err)
	}
}

func TestClientCredentials(t *testing.T) {
	f := newFakeRegistry(t)
	f.requireUser, f.requirePass = "alice", "s3cret"
	ctx := context.Background()

	bad := NewClient(f.srv.URL, "alice", "wrong")
	if _, err := bad.HeadManifest(ctx, "library/alpine", "latest"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong creds: err = %v, want ErrUnauthorized", err)
	}
	anon := NewClient(f.srv.URL, "", "")
	if _, err := anon.HeadManifest(ctx, "library/alpine", "latest"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("anonymous: err = %v, want ErrUnauthorized", err)
	}
	good := NewClient(f.srv.URL, "alice", "s3cret")
	if _, err := good.HeadManifest(ctx, "library/alpine", "latest"); err != nil {
		t.Fatalf("good creds: %v", err)
	}
}

func TestClientHeadFallsBackToGet(t *testing.T) {
	f := newFakeRegistry(t)
	f.noHeadDigest = true
	c := NewClient(f.srv.URL, "", "")
	head, err := c.HeadManifest(context.Background(), "library/alpine", "latest")
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.Digest != f.digest {
		t.Fatalf("digest = %q, want %q", head.Digest, f.digest)
	}
}

func TestClientDigestMismatch(t *testing.T) {
	f := newFakeRegistry(t)
	c := NewClient(f.srv.URL, "", "")
	other := "sha256:" + strings.Repeat("ab", 32)
	// The fake serves the same manifest for a different digest reference? It
	// answers 404 for unknown digests, so emulate a lying upstream instead.
	f.manifest = append(f.manifest, '\n') // content changed, header digest stale
	if _, err := c.GetManifest(context.Background(), "library/alpine", "latest"); !errors.Is(err, ErrDigest) {
		t.Fatalf("stale header: err = %v, want ErrDigest", err)
	}
	if _, err := c.GetManifest(context.Background(), "library/alpine", other); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown digest: err = %v", err)
	}
}

func TestClientBasicChallenge(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		u, p, ok := r.BasicAuth()
		if !ok || u != "bob" || p != "pw" {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, "{}")
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "bob", "pw")
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	// Basic auth is remembered: the second call needs no challenge round trip.
	before := hits.Load()
	if err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping 2: %v", err)
	}
	if hits.Load()-before != 1 {
		t.Fatalf("second ping took %d requests, want 1", hits.Load()-before)
	}
}
