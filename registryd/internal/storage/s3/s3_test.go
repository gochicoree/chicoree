package s3

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"registryd/internal/storage"
)

// fakeS3 emulates the handful of S3 operations the driver uses, path-style
// under one bucket: Put/Get/Head/Delete object, ListObjectsV2 and the
// multipart trio (create, upload part, complete/abort).
type fakeS3 struct {
	mu                                      sync.Mutex
	objects                                 map[string][]byte
	uploads                                 map[string]map[int][]byte
	nextID                                  int
	puts, creates, completes, aborts, parts int
}

func newFakeS3() *fakeS3 {
	return &fakeS3{objects: map[string][]byte{}, uploads: map[string]map[int][]byte{}}
}

func xmlError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, code)
}

func (f *fakeS3) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if !strings.HasPrefix(r.URL.Path, "/bucket") {
			xmlError(w, http.StatusNotFound, "NoSuchBucket")
			return
		}
		key := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/bucket"), "/")
		q := r.URL.Query()
		switch {
		case key == "" && r.Method == http.MethodHead:
			w.WriteHeader(http.StatusOK)
		case key == "" && r.Method == http.MethodGet:
			prefix := q.Get("prefix")
			var keys []string
			for k := range f.objects {
				if strings.HasPrefix(k, prefix) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			var b strings.Builder
			fmt.Fprintf(&b, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>%s</Prefix><KeyCount>%d</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`, prefix, len(keys))
			for _, k := range keys {
				fmt.Fprintf(&b, `<Contents><Key>%s</Key><Size>%d</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>`, k, len(f.objects[k]))
			}
			b.WriteString(`</ListBucketResult>`)
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, b.String())
		case r.Method == http.MethodPost && q.Has("uploads"):
			f.nextID++
			id := "upload-" + strconv.Itoa(f.nextID)
			f.uploads[id] = map[int][]byte{}
			f.creates++
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>bucket</Bucket><Key>%s</Key><UploadId>%s</UploadId></InitiateMultipartUploadResult>`, key, id)
		case r.Method == http.MethodPut && q.Has("uploadId"):
			parts, ok := f.uploads[q.Get("uploadId")]
			if !ok {
				xmlError(w, http.StatusNotFound, "NoSuchUpload")
				return
			}
			num, _ := strconv.Atoi(q.Get("partNumber"))
			data, _ := io.ReadAll(r.Body)
			parts[num] = data
			f.parts++
			w.Header().Set("ETag", fmt.Sprintf(`"part-%d"`, num))
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && q.Has("uploadId"):
			id := q.Get("uploadId")
			parts, ok := f.uploads[id]
			if !ok {
				xmlError(w, http.StatusNotFound, "NoSuchUpload")
				return
			}
			nums := make([]int, 0, len(parts))
			for n := range parts {
				nums = append(nums, n)
			}
			sort.Ints(nums)
			var data []byte
			for _, n := range nums {
				data = append(data, parts[n]...)
			}
			f.objects[key] = data
			delete(f.uploads, id)
			f.completes++
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>http://bucket/%s</Location><Bucket>bucket</Bucket><Key>%s</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`, key, key)
		case r.Method == http.MethodDelete && q.Has("uploadId"):
			delete(f.uploads, q.Get("uploadId"))
			f.aborts++
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPut:
			data, _ := io.ReadAll(r.Body)
			f.objects[key] = data
			f.puts++
			w.Header().Set("ETag", `"put"`)
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet:
			data, ok := f.objects[key]
			if !ok {
				xmlError(w, http.StatusNotFound, "NoSuchKey")
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			_, _ = w.Write(data)
		case r.Method == http.MethodHead:
			data, ok := f.objects[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete:
			delete(f.objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}

func newTestDriver(t *testing.T) (*Driver, *fakeS3) {
	t.Helper()
	fake := newFakeS3()
	srv := httptest.NewServer(fake.handler())
	t.Cleanup(srv.Close)
	d, err := New(context.Background(), Options{
		Endpoint: srv.URL, Region: "us-east-1", Bucket: "bucket",
		AccessKey: "key", SecretKey: "secret", ForcePathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return d, fake
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func TestPutSmallUsesSinglePut(t *testing.T) {
	d, fake := newTestDriver(t)
	ctx := context.Background()
	content := randomBytes(1000)
	digest := digestOf(content)
	if err := d.Put(ctx, digest, storage.NewVerifyingReader(bytes.NewReader(content), digest), int64(len(content))); err != nil {
		t.Fatal(err)
	}
	if fake.puts != 1 || fake.creates != 0 {
		t.Fatalf("puts=%d creates=%d, want a single PutObject", fake.puts, fake.creates)
	}
	if !bytes.Equal(fake.objects[storage.BlobPath(digest)], content) {
		t.Fatal("stored content differs")
	}
	if n, err := d.Stat(ctx, digest); err != nil || n != 1000 {
		t.Fatalf("Stat = %d, %v", n, err)
	}
	rc, n, err := d.Get(ctx, digest)
	if err != nil || n != 1000 {
		t.Fatalf("Get = %d, %v", n, err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(got, content) {
		t.Fatal("Get content differs")
	}
	if _, err := d.Stat(ctx, "sha256:"+strings.Repeat("0", 64)); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("missing Stat = %v", err)
	}
	if _, _, err := d.Get(ctx, "sha256:"+strings.Repeat("0", 64)); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("missing Get = %v", err)
	}
}

func TestPutLargeUsesMultipart(t *testing.T) {
	d, fake := newTestDriver(t)
	ctx := context.Background()
	content := randomBytes(2*partSize + 100)
	digest := digestOf(content)
	if err := d.Put(ctx, digest, storage.NewVerifyingReader(bytes.NewReader(content), digest), int64(len(content))); err != nil {
		t.Fatal(err)
	}
	if fake.creates != 1 || fake.completes != 1 || fake.parts != 3 || fake.puts != 0 || fake.aborts != 0 {
		t.Fatalf("creates=%d completes=%d parts=%d puts=%d aborts=%d", fake.creates, fake.completes, fake.parts, fake.puts, fake.aborts)
	}
	if !bytes.Equal(fake.objects[storage.BlobPath(digest)], content) {
		t.Fatal("assembled content differs")
	}
	if len(fake.uploads) != 0 {
		t.Fatal("multipart upload left open")
	}

	// Exactly two parts: the body ends on a part boundary.
	content = randomBytes(2 * partSize)
	digest = digestOf(content)
	if err := d.Put(ctx, digest, bytes.NewReader(content), int64(len(content))); err != nil {
		t.Fatal(err)
	}
	if fake.parts != 5 || !bytes.Equal(fake.objects[storage.BlobPath(digest)], content) {
		t.Fatalf("boundary case: parts=%d", fake.parts)
	}
}

func TestPutDigestMismatchLeavesNothing(t *testing.T) {
	d, fake := newTestDriver(t)
	ctx := context.Background()
	wrong := digestOf([]byte("not this"))

	// Large: the multipart upload must be aborted, never completed.
	content := randomBytes(partSize + 10)
	err := d.Put(ctx, wrong, storage.NewVerifyingReader(bytes.NewReader(content), wrong), int64(len(content)))
	if !errors.Is(err, storage.ErrDigestMismatch) {
		t.Fatalf("large mismatch = %v", err)
	}
	if fake.completes != 0 || fake.aborts != 1 || len(fake.uploads) != 0 {
		t.Fatalf("completes=%d aborts=%d open=%d", fake.completes, fake.aborts, len(fake.uploads))
	}
	if _, ok := fake.objects[storage.BlobPath(wrong)]; ok {
		t.Fatal("object visible despite mismatch")
	}

	// Small: nothing is sent at all.
	content = randomBytes(10)
	err = d.Put(ctx, wrong, storage.NewVerifyingReader(bytes.NewReader(content), wrong), 10)
	if !errors.Is(err, storage.ErrDigestMismatch) || fake.puts != 0 {
		t.Fatalf("small mismatch = %v, puts=%d", err, fake.puts)
	}

	// Size mismatch: the caller's size is authoritative.
	content = randomBytes(partSize + 10)
	if err := d.Put(ctx, digestOf(content), bytes.NewReader(content), int64(len(content))+1); err == nil || fake.aborts != 2 {
		t.Fatalf("short write = %v, aborts=%d", err, fake.aborts)
	}
	if err := d.Put(ctx, digestOf(content[:10]), bytes.NewReader(content[:10]), 11); err == nil || fake.puts != 0 {
		t.Fatalf("small short write = %v, puts=%d", err, fake.puts)
	}
}

func TestObjectStore(t *testing.T) {
	d, fake := newTestDriver(t)
	ctx := context.Background()
	var _ storage.ObjectStore = d

	if n, err := d.PutObject(ctx, "_uploads/s1/0-aa", strings.NewReader("hello"), -1); err != nil || n != 5 {
		t.Fatalf("PutObject = %d, %v", n, err)
	}
	big := randomBytes(partSize + 1)
	if n, err := d.PutObject(ctx, "_uploads/s1/1-bb", bytes.NewReader(big), -1); err != nil || n != int64(len(big)) {
		t.Fatalf("large PutObject = %d, %v", n, err)
	}
	if _, err := d.PutObject(ctx, "_uploads/s2/0-cc", strings.NewReader("x"), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PutObject(ctx, "../escape", strings.NewReader("x"), 1); err == nil {
		t.Fatal("invalid key accepted")
	}
	if !bytes.Equal(fake.objects["_uploads/s1/1-bb"], big) {
		t.Fatal("large object differs")
	}

	rc, size, err := d.GetObject(ctx, "_uploads/s1/0-aa")
	if err != nil || size != 5 {
		t.Fatalf("GetObject = %d, %v", size, err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "hello" {
		t.Fatalf("GetObject content = %q", got)
	}
	if _, _, err := d.GetObject(ctx, "_uploads/none"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("missing GetObject = %v", err)
	}

	list, err := d.ListObjects(ctx, "_uploads/")
	if err != nil || len(list) != 3 {
		t.Fatalf("ListObjects = %d, %v", len(list), err)
	}
	if list[0].Key != "_uploads/s1/0-aa" || list[0].Size != 5 || list[0].ModTime.IsZero() {
		t.Fatalf("first entry = %+v", list[0])
	}
	if list, _ := d.ListObjects(ctx, "_uploads/s2/"); len(list) != 1 {
		t.Fatalf("prefix listing = %d", len(list))
	}

	if err := d.DeleteObject(ctx, "_uploads/s1/0-aa"); err != nil {
		t.Fatal(err)
	}
	if err := d.DeleteObject(ctx, "_uploads/s1/0-aa"); err != nil {
		t.Fatalf("second delete: %v", err)
	}
	if list, _ := d.ListObjects(ctx, "_uploads/"); len(list) != 2 {
		t.Fatalf("after delete = %d", len(list))
	}
}
