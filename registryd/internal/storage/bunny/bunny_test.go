package bunny

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"registryd/internal/storage"
)

// fakeZone emulates the subset of the Edge Storage API the driver uses.
type fakeZone struct {
	mu      sync.Mutex
	objects map[string][]byte
	key     string
	headOK  bool // whether HEAD is supported
}

func (z *fakeZone) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("AccessKey") != z.key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/zone1/")
		z.mu.Lock()
		defer z.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			if strings.HasSuffix(p, "/") || p == "" {
				var entries []map[string]any
				for name, data := range z.objects {
					if strings.HasPrefix(name, p) && !strings.Contains(strings.TrimPrefix(name, p), "/") {
						entries = append(entries, map[string]any{
							"ObjectName": strings.TrimPrefix(name, p), "Length": len(data), "IsDirectory": false,
						})
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(entries)
				return
			}
			data, ok := z.objects[p]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", itoa(len(data)))
			_, _ = w.Write(data)
		case http.MethodHead:
			if !z.headOK {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			data, ok := z.objects[p]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", itoa(len(data)))
			w.WriteHeader(http.StatusOK)
		case http.MethodPut:
			data, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(data)
			if want := r.Header.Get("Checksum"); want != "" && want != strings.ToUpper(hex.EncodeToString(sum[:])) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			z.objects[p] = data
			w.WriteHeader(http.StatusCreated)
		case http.MethodDelete:
			if _, ok := z.objects[p]; !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			delete(z.objects, p)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestRoundTrip(t *testing.T) {
	for _, headOK := range []bool{true, false} {
		zone := &fakeZone{objects: map[string][]byte{}, key: "secret", headOK: headOK}
		srv := httptest.NewServer(zone.handler(t))
		defer srv.Close()

		d, err := New(context.Background(), Options{
			StorageZone: "zone1", AccessKey: "secret", Endpoint: srv.URL,
		})
		if err != nil {
			t.Fatal(err)
		}

		content := []byte("hello registry")
		sum := sha256.Sum256(content)
		digest := "sha256:" + hex.EncodeToString(sum[:])

		if _, err := d.Stat(context.Background(), digest); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("headOK=%v: expected ErrNotFound before put, got %v", headOK, err)
		}
		if err := d.Put(context.Background(), digest, bytes.NewReader(content), int64(len(content))); err != nil {
			t.Fatalf("put: %v", err)
		}
		if _, ok := zone.objects[storage.BlobPath(digest)]; !ok {
			t.Fatalf("object not stored under %s", storage.BlobPath(digest))
		}
		size, err := d.Stat(context.Background(), digest)
		if err != nil || size != int64(len(content)) {
			t.Fatalf("headOK=%v: stat = %d, %v", headOK, size, err)
		}
		rc, n, err := d.Get(context.Background(), digest)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(rc)
		rc.Close()
		if !bytes.Equal(got, content) || n != int64(len(content)) {
			t.Fatalf("get mismatch: %q (%d)", got, n)
		}
		if err := d.Delete(context.Background(), digest); err != nil {
			t.Fatal(err)
		}
		if err := d.Delete(context.Background(), digest); err != nil {
			t.Fatalf("second delete should be a no-op: %v", err)
		}
		if _, err := d.Stat(context.Background(), digest); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("expected ErrNotFound after delete, got %v", err)
		}
	}
}

func TestChecksumRejected(t *testing.T) {
	zone := &fakeZone{objects: map[string][]byte{}, key: "secret", headOK: true}
	srv := httptest.NewServer(zone.handler(t))
	defer srv.Close()
	d, err := New(context.Background(), Options{StorageZone: "zone1", AccessKey: "secret", Endpoint: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	// Digest does not match the content: the zone must refuse it.
	err = d.Put(context.Background(), "sha256:"+strings.Repeat("ab", 32), strings.NewReader("other"), 5)
	if err == nil {
		t.Fatal("expected checksum rejection")
	}
}

func TestCDNRequiresTokenKey(t *testing.T) {
	_, err := New(context.Background(), Options{StorageZone: "z", AccessKey: "k", CDNURL: "https://x.b-cdn.net"})
	if err == nil {
		t.Fatal("expected error when CDN_URL is set without CDN_TOKEN_KEY")
	}
}

func TestSignCDNURL(t *testing.T) {
	u := SignCDNURL("https://img.b-cdn.net/", "key", "/blobs/sha256/ab/abc", 1700000000)
	if !strings.HasPrefix(u, "https://img.b-cdn.net/blobs/sha256/ab/abc?token=") || !strings.HasSuffix(u, "&expires=1700000000") {
		t.Fatalf("unexpected url %s", u)
	}
	if strings.ContainsAny(strings.Split(strings.Split(u, "token=")[1], "&")[0], "+/=") {
		t.Fatal("token must be base64url without padding")
	}
}
