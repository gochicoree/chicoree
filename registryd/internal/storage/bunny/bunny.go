// Package bunny stores blobs in a bunny.net Edge Storage zone and can hand
// out signed CDN URLs for downloads. Selected with STORAGE_DRIVER=bunny.
//
// API reference: https://docs.bunny.net/reference/storage-api
package bunny

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"registryd/internal/storage"
)

func init() {
	storage.Register(&storage.Plugin{
		Name:        "bunny",
		Description: "bunny.net Edge Storage, optionally fronted by a Bunny CDN pull zone.",
		Options: []storage.OptionDoc{
			{Key: "STORAGE_ZONE", Description: "Storage zone name", Required: true},
			{Key: "ACCESS_KEY", Description: "Storage zone password / API access key", Required: true},
			{Key: "REGION", Description: "Zone region code (ny, la, sg, se, br, jh, syd, uk); empty = Falkenstein (DE)"},
			{Key: "ENDPOINT", Description: "Override the storage API base URL (derived from REGION when empty)"},
			{Key: "CDN_URL", Description: "Pull zone base URL, e.g. https://images.b-cdn.net, to redirect blob downloads"},
			{Key: "CDN_TOKEN_KEY", Description: "Pull zone token-authentication key; required with CDN_URL so URLs are signed"},
			{Key: "PRESIGN_EXPIRY", Description: "Signed CDN URL lifetime", Default: "20m"},
		},
		New: func(ctx context.Context, o storage.Options) (storage.Driver, error) {
			return New(ctx, Options{
				StorageZone:   storage.Get(o, "STORAGE_ZONE", ""),
				AccessKey:     storage.Get(o, "ACCESS_KEY", ""),
				Region:        storage.Get(o, "REGION", ""),
				Endpoint:      storage.Get(o, "ENDPOINT", ""),
				CDNURL:        storage.Get(o, "CDN_URL", ""),
				CDNTokenKey:   storage.Get(o, "CDN_TOKEN_KEY", ""),
				PresignExpiry: storage.GetDuration(o, "PRESIGN_EXPIRY", 20*time.Minute),
			})
		},
	})
}

// Options configures the bunny.net driver.
type Options struct {
	StorageZone   string
	AccessKey     string
	Region        string
	Endpoint      string
	CDNURL        string
	CDNTokenKey   string
	PresignExpiry time.Duration
}

// Driver talks to the Edge Storage HTTP API.
type Driver struct {
	base   string // https://<region>.storage.bunnycdn.com/<zone>
	opts   Options
	client *http.Client
}

// New validates options and checks the zone is reachable.
func New(ctx context.Context, opts Options) (*Driver, error) {
	if opts.StorageZone == "" || opts.AccessKey == "" {
		return nil, errors.New("bunny: STORAGE_ZONE and ACCESS_KEY are required")
	}
	if opts.CDNURL != "" && opts.CDNTokenKey == "" {
		return nil, errors.New("bunny: CDN_URL requires CDN_TOKEN_KEY so download URLs are signed (private blobs must not be served from an open pull zone)")
	}
	if opts.PresignExpiry <= 0 {
		opts.PresignExpiry = 20 * time.Minute
	}
	endpoint := opts.Endpoint
	if endpoint == "" {
		host := "storage.bunnycdn.com"
		if opts.Region != "" {
			host = opts.Region + "." + host
		}
		endpoint = "https://" + host
	}
	d := &Driver{
		base:   strings.TrimSuffix(endpoint, "/") + "/" + url.PathEscape(opts.StorageZone),
		opts:   opts,
		client: &http.Client{Timeout: 0}, // blob transfers can be long; per-request contexts bound them
	}
	// Listing the zone root verifies credentials without touching blobs.
	if _, err := d.list(ctx, ""); err != nil {
		return nil, fmt.Errorf("bunny: zone %q not reachable: %w", opts.StorageZone, err)
	}
	return d, nil
}

func (d *Driver) Name() string { return "bunny" }

func (d *Driver) objectURL(digest string) string { return d.base + "/" + storage.BlobPath(digest) }

func (d *Driver) newRequest(ctx context.Context, method, u string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("AccessKey", d.opts.AccessKey)
	req.Header.Set("Accept", "*/*")
	return req, nil
}

type listEntry struct {
	ObjectName  string `json:"ObjectName"`
	Length      int64  `json:"Length"`
	IsDirectory bool   `json:"IsDirectory"`
}

// list fetches a directory listing (path relative to the zone, with trailing slash).
func (d *Driver) list(ctx context.Context, dir string) ([]listEntry, error) {
	req, err := d.newRequest(ctx, http.MethodGet, d.base+"/"+dir, nil)
	if err != nil {
		return nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list %s: HTTP %d", dir, resp.StatusCode)
	}
	var entries []listEntry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		return nil, fmt.Errorf("list %s: decode: %w", dir, err)
	}
	return entries, nil
}

func (d *Driver) Get(ctx context.Context, digest string) (io.ReadCloser, int64, error) {
	req, err := d.newRequest(ctx, http.MethodGet, d.objectURL(digest), nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return resp.Body, resp.ContentLength, nil
	case http.StatusNotFound:
		resp.Body.Close()
		return nil, 0, storage.ErrNotFound
	default:
		resp.Body.Close()
		return nil, 0, fmt.Errorf("bunny get %s: HTTP %d", digest, resp.StatusCode)
	}
}

// OpenRange implements storage.RangeReader by sending an HTTP Range header
// to the storage API. Edge Storage answers 206 for byte ranges; should an
// endpoint reply with the whole object instead, the surplus is discarded so
// the caller always receives exactly the requested window.
func (d *Driver) OpenRange(ctx context.Context, digest string, offset, length int64) (io.ReadCloser, error) {
	if length == 0 {
		return io.NopCloser(strings.NewReader("")), nil
	}
	req, err := d.newRequest(ctx, http.MethodGet, d.objectURL(digest), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	switch resp.StatusCode {
	case http.StatusPartialContent:
		return storage.SkipAndLimit(resp.Body, 0, length)
	case http.StatusOK:
		return storage.SkipAndLimit(resp.Body, offset, length)
	case http.StatusNotFound:
		resp.Body.Close()
		return nil, storage.ErrNotFound
	default:
		resp.Body.Close()
		return nil, fmt.Errorf("bunny range get %s: HTTP %d", digest, resp.StatusCode)
	}
}

// Stat tries a HEAD request first and falls back to a directory listing,
// which the storage API always supports.
func (d *Driver) Stat(ctx context.Context, digest string) (int64, error) {
	req, err := d.newRequest(ctx, http.MethodHead, d.objectURL(digest), nil)
	if err != nil {
		return 0, err
	}
	resp, err := d.client.Do(req)
	if err == nil {
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusNotFound:
			return 0, storage.ErrNotFound
		case resp.StatusCode == http.StatusOK && resp.ContentLength > 0:
			return resp.ContentLength, nil
		}
	}
	// Fallback: list the parent directory and find the object.
	p := storage.BlobPath(digest)
	entries, err := d.list(ctx, path.Dir(p)+"/")
	if err != nil {
		return 0, err
	}
	name := path.Base(p)
	for _, e := range entries {
		if !e.IsDirectory && e.ObjectName == name {
			return e.Length, nil
		}
	}
	return 0, storage.ErrNotFound
}

func (d *Driver) Put(ctx context.Context, digest string, r io.Reader, size int64) error {
	req, err := d.newRequest(ctx, http.MethodPut, d.objectURL(digest), r)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	// The storage API verifies uploads against this SHA256 (uppercase hex).
	if strings.HasPrefix(digest, "sha256:") {
		req.Header.Set("Checksum", strings.ToUpper(storage.DigestHex(digest)))
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("bunny put %s: HTTP %d: %s", digest, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (d *Driver) Delete(ctx context.Context, digest string) error {
	req, err := d.newRequest(ctx, http.MethodDelete, d.objectURL(digest), nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("bunny delete %s: HTTP %d", digest, resp.StatusCode)
	}
	return nil
}

// RedirectURL returns a token-authenticated pull-zone URL when a CDN is
// configured. Bunny's token scheme: base64url(sha256(key + path + expires)).
func (d *Driver) RedirectURL(_ context.Context, digest string) (string, error) {
	if d.opts.CDNURL == "" {
		return "", nil
	}
	expires := time.Now().Add(d.opts.PresignExpiry).Unix()
	return SignCDNURL(d.opts.CDNURL, d.opts.CDNTokenKey, "/"+storage.BlobPath(digest), expires), nil
}

// --- storage.ObjectStore: arbitrary paths in the zone (shared staging) ---

// PutObject uploads to an arbitrary path. The storage API needs a
// Content-Length, so a body of unknown size is spooled through a temporary
// file first.
func (d *Driver) PutObject(ctx context.Context, key string, r io.Reader, size int64) (int64, error) {
	if !storage.ValidObjectKey(key) {
		return 0, fmt.Errorf("invalid object key %q", key)
	}
	if size < 0 {
		tmp, err := os.CreateTemp("", "bunny-obj-*")
		if err != nil {
			return 0, err
		}
		defer os.Remove(tmp.Name())
		defer tmp.Close()
		n, err := io.Copy(tmp, r)
		if err != nil {
			return 0, err
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			return 0, err
		}
		r, size = tmp, n
	}
	req, err := d.newRequest(ctx, http.MethodPut, d.base+"/"+key, r)
	if err != nil {
		return 0, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("bunny put %s: HTTP %d: %s", key, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return size, nil
}

func (d *Driver) GetObject(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	if !storage.ValidObjectKey(key) {
		return nil, 0, fmt.Errorf("invalid object key %q", key)
	}
	req, err := d.newRequest(ctx, http.MethodGet, d.base+"/"+key, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return resp.Body, resp.ContentLength, nil
	case http.StatusNotFound:
		resp.Body.Close()
		return nil, 0, storage.ErrNotFound
	default:
		resp.Body.Close()
		return nil, 0, fmt.Errorf("bunny get %s: HTTP %d", key, resp.StatusCode)
	}
}

func (d *Driver) DeleteObject(ctx context.Context, key string) error {
	if !storage.ValidObjectKey(key) {
		return fmt.Errorf("invalid object key %q", key)
	}
	req, err := d.newRequest(ctx, http.MethodDelete, d.base+"/"+key, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("bunny delete %s: HTTP %d", key, resp.StatusCode)
	}
	return nil
}

// ListObjects walks the directory tree the prefix points into (the storage
// API lists one directory at a time).
func (d *Driver) ListObjects(ctx context.Context, prefix string) ([]storage.ObjectInfo, error) {
	dir := prefix
	if !strings.HasSuffix(dir, "/") {
		dir = path.Dir(dir)
		if dir == "." {
			dir = ""
		} else {
			dir += "/"
		}
	}
	var out []storage.ObjectInfo
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := d.list(ctx, dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			key := dir + e.ObjectName
			if e.IsDirectory {
				if err := walk(key + "/"); err != nil {
					return err
				}
				continue
			}
			if strings.HasPrefix(key, prefix) {
				out = append(out, storage.ObjectInfo{Key: key, Size: e.Length})
			}
		}
		return nil
	}
	if err := walk(dir); err != nil {
		return nil, err
	}
	return out, nil
}

// SignCDNURL builds a Bunny CDN token-authentication URL for the given path.
func SignCDNURL(cdnBase, key, urlPath string, expires int64) string {
	sum := sha256.Sum256([]byte(key + urlPath + strconv.FormatInt(expires, 10)))
	token := base64.RawURLEncoding.EncodeToString(sum[:])
	return strings.TrimSuffix(cdnBase, "/") + urlPath + "?token=" + token + "&expires=" + strconv.FormatInt(expires, 10)
}

// ChecksumFor is exported for tests: the header value Put sends.
func ChecksumFor(digest string) string {
	return strings.ToUpper(hex.EncodeToString(mustHex(storage.DigestHex(digest))))
}

func mustHex(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}
