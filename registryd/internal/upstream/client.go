package upstream

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Sentinel errors callers map to OCI responses.
var (
	ErrNotFound     = errors.New("not found upstream")
	ErrUnauthorized = errors.New("upstream rejected the proxy credentials")
	ErrDenied       = errors.New("upstream denied access")
	ErrRateLimited  = errors.New("upstream rate limit reached")
	ErrDigest       = errors.New("upstream content does not match its digest")
)

// Error carries the HTTP status and the first OCI error message a registry
// answered with.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("upstream answered %d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("upstream answered HTTP %d", e.Status)
}

// Is lets errors.Is match the sentinels above.
func (e *Error) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Status == http.StatusNotFound
	case ErrUnauthorized:
		return e.Status == http.StatusUnauthorized
	case ErrDenied:
		return e.Status == http.StatusForbidden
	case ErrRateLimited:
		return e.Status == http.StatusTooManyRequests
	}
	return false
}

// ManifestAccept is the Accept list sent with manifest requests; the order
// matters for registries that pick the first acceptable representation.
const ManifestAccept = "application/vnd.oci.image.index.v1+json, " +
	"application/vnd.docker.distribution.manifest.list.v2+json, " +
	"application/vnd.oci.image.manifest.v1+json, " +
	"application/vnd.docker.distribution.manifest.v2+json"

// maxManifestBytes caps manifest payloads (the spec recommends 4 MiB).
const maxManifestBytes = 4 << 20

// Client fetches from one upstream registry with cached per-scope tokens.
type Client struct {
	// BaseURL is the API root, e.g. https://registry-1.docker.io.
	BaseURL string
	// Username/Password are used for Basic challenges and for token
	// requests. A bare token (no username) is sent as the Basic password.
	Username string
	Password string
	// HTTP is the underlying client; nil means a default with sane timeouts.
	HTTP *http.Client
	// OnRequest, when set, is called for every request sent upstream (used
	// for the per-request log line).
	OnRequest func(method, url string)

	mu     sync.Mutex
	tokens map[string]tokenEntry
	// basic is set once a Basic challenge was answered successfully.
	basic bool
}

type tokenEntry struct {
	value   string
	expires time.Time
}

// NewClient returns a client with a default transport: dial/TLS timeouts,
// no overall timeout (blob transfers are long-lived), redirects followed.
func NewClient(baseURL, username, password string) *Client {
	return &Client{
		BaseURL:  strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Username: username,
		Password: password,
		HTTP:     DefaultHTTPClient(),
	}
}

// DefaultHTTPClient builds the transport used for upstream requests.
func DefaultHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			MaxIdleConns:          32,
			IdleConnTimeout:       90 * time.Second,
		},
	}
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) basicHeader() string {
	if c.Username == "" && c.Password == "" {
		return ""
	}
	return "Basic " + basicAuth(c.Username, c.Password)
}

func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

// scopeFor is the token scope a repository request needs.
func scopeFor(repository string) string {
	return "repository:" + repository + ":pull"
}

// do sends a request, answering an authentication challenge once. Transient
// network errors are retried a few times before the body is consumed.
func (c *Client) do(ctx context.Context, method, path, scope string, headers map[string]string) (*http.Response, error) {
	target := path
	if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
		target = c.BaseURL + path
	}

	build := func(auth string) (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, method, target, nil)
		if err != nil {
			return nil, err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		return req, nil
	}

	resp, err := c.send(build, c.cachedAuth(scope))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized {
		return resp, nil
	}
	challenge := ParseChallenge(resp.Header.Get("WWW-Authenticate"))
	drain(resp)

	var auth string
	switch challenge.Scheme {
	case "bearer":
		auth, err = c.fetchToken(ctx, challenge, scope)
		if err != nil {
			return nil, err
		}
	case "basic":
		auth = c.basicHeader()
		if auth == "" {
			return nil, &Error{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "registry requires credentials"}
		}
		c.mu.Lock()
		c.basic = true
		c.mu.Unlock()
	default:
		return nil, &Error{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "unsupported authentication challenge"}
	}

	resp, err = c.send(build, auth)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		c.forget(scope)
		e := readError(resp)
		if e.Message == "" {
			e.Message = "authentication failed"
		}
		return nil, e
	}
	return resp, nil
}

// send performs the request with retries for connection-level failures.
func (c *Client) send(build func(auth string) (*http.Request, error), auth string) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 300 * time.Millisecond):
			}
		}
		req, err := build(auth)
		if err != nil {
			return nil, err
		}
		if c.OnRequest != nil {
			c.OnRequest(req.Method, req.URL.String())
		}
		resp, err := c.httpClient().Do(req)
		if err == nil {
			if resp.StatusCode >= 500 && resp.StatusCode != http.StatusNotImplemented && attempt < 2 {
				drain(resp)
				lastErr = &Error{Status: resp.StatusCode}
				continue
			}
			return resp, nil
		}
		lastErr = err
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
	}
	return nil, fmt.Errorf("upstream unreachable: %w", lastErr)
}

func (c *Client) cachedAuth(scope string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.basic {
		return c.basicHeader()
	}
	if t, ok := c.tokens[scope]; ok && time.Now().Before(t.expires) {
		return "Bearer " + t.value
	}
	return ""
}

func (c *Client) forget(scope string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.tokens, scope)
}

// fetchToken asks the realm named in a Bearer challenge for a token. Docker
// Hub hands out anonymous tokens without credentials; with credentials the
// token endpoint is called with Basic auth.
func (c *Client) fetchToken(ctx context.Context, ch Challenge, scope string) (string, error) {
	realm := ch.Params["realm"]
	if realm == "" {
		return "", &Error{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "bearer challenge without realm"}
	}
	u, err := url.Parse(realm)
	if err != nil {
		return "", fmt.Errorf("invalid token realm %q: %w", realm, err)
	}
	q := u.Query()
	if svc := ch.Params["service"]; svc != "" {
		q.Set("service", svc)
	}
	if s := ch.Params["scope"]; s != "" {
		q.Set("scope", s)
	} else if scope != "" {
		q.Set("scope", scope)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	if basic := c.basicHeader(); basic != "" {
		req.Header.Set("Authorization", basic)
	}
	if c.OnRequest != nil {
		c.OnRequest(req.Method, req.URL.String())
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", &Error{Status: http.StatusUnauthorized, Code: "UNAUTHORIZED", Message: "token endpoint rejected the proxy credentials"}
	}
	if resp.StatusCode != http.StatusOK {
		return "", &Error{Status: http.StatusBadGateway, Code: "UNAVAILABLE", Message: fmt.Sprintf("token endpoint answered HTTP %d", resp.StatusCode)}
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("token endpoint returned invalid JSON: %w", err)
	}
	token := body.Token
	if token == "" {
		token = body.AccessToken
	}
	if token == "" {
		return "", fmt.Errorf("token endpoint returned no token")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	if ttl < 60*time.Second {
		ttl = 60 * time.Second
	}
	c.mu.Lock()
	if c.tokens == nil {
		c.tokens = map[string]tokenEntry{}
	}
	// Refresh a little early so a token never expires mid-request.
	c.tokens[scope] = tokenEntry{value: token, expires: time.Now().Add(ttl - 10*time.Second)}
	c.mu.Unlock()
	return "Bearer " + token, nil
}

// Ping checks that the upstream speaks the distribution API and that the
// credentials (if any) are accepted.
func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.do(ctx, http.MethodGet, "/v2/", "", nil)
	if err != nil {
		return err
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	return readError(resp)
}

// ManifestInfo describes a manifest without its payload.
type ManifestInfo struct {
	Digest    string
	MediaType string
	Size      int64
}

// Manifest is a fetched manifest with its verified digest.
type Manifest struct {
	ManifestInfo
	Payload []byte
}

// HeadManifest resolves a tag or digest to its digest with a HEAD request;
// registries that omit Docker-Content-Digest on HEAD fall back to a GET.
func (c *Client) HeadManifest(ctx context.Context, repository, reference string) (*ManifestInfo, error) {
	resp, err := c.do(ctx, http.MethodHead, "/v2/"+repository+"/manifests/"+reference, scopeFor(repository),
		map[string]string{"Accept": ManifestAccept})
	if err != nil {
		return nil, err
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return nil, readError(resp)
	}
	digest := strings.TrimSpace(resp.Header.Get("Docker-Content-Digest"))
	if digest == "" {
		m, err := c.GetManifest(ctx, repository, reference)
		if err != nil {
			return nil, err
		}
		return &m.ManifestInfo, nil
	}
	size, _ := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	return &ManifestInfo{Digest: digest, MediaType: mediaType(resp), Size: size}, nil
}

// GetManifest fetches a manifest and verifies its digest against the
// Docker-Content-Digest header and, when the reference is a digest, that.
func (c *Client) GetManifest(ctx context.Context, repository, reference string) (*Manifest, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/"+repository+"/manifests/"+reference, scopeFor(repository),
		map[string]string{"Accept": ManifestAccept})
	if err != nil {
		return nil, err
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return nil, readError(resp)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read upstream manifest: %w", err)
	}
	if len(payload) > maxManifestBytes {
		return nil, fmt.Errorf("upstream manifest exceeds %d bytes", maxManifestBytes)
	}
	sum := sha256.Sum256(payload)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if h := strings.TrimSpace(resp.Header.Get("Docker-Content-Digest")); h != "" && h != digest {
		return nil, fmt.Errorf("%w: header says %s, content is %s", ErrDigest, h, digest)
	}
	if strings.Contains(reference, ":") && reference != digest {
		return nil, fmt.Errorf("%w: requested %s, content is %s", ErrDigest, reference, digest)
	}
	return &Manifest{
		ManifestInfo: ManifestInfo{Digest: digest, MediaType: mediaType(resp), Size: int64(len(payload))},
		Payload:      payload,
	}, nil
}

// OpenBlob streams a blob. The caller must close the body and verify the
// digest while copying. Size is -1 when the upstream sends no length.
func (c *Client) OpenBlob(ctx context.Context, repository, digest string) (io.ReadCloser, int64, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v2/"+repository+"/blobs/"+digest, scopeFor(repository), nil)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		defer drain(resp)
		return nil, 0, readError(resp)
	}
	size := int64(-1)
	if resp.ContentLength >= 0 {
		size = resp.ContentLength
	}
	return resp.Body, size, nil
}

func mediaType(resp *http.Response) string {
	ct := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	ct = strings.TrimSpace(ct)
	if ct == "" {
		ct = "application/octet-stream"
	}
	return ct
}

// readError turns a non-2xx response into an *Error, using the OCI error
// body when there is one.
func readError(resp *http.Response) *Error {
	e := &Error{Status: resp.StatusCode}
	var body struct {
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if json.Unmarshal(raw, &body) == nil && len(body.Errors) > 0 {
		e.Code = body.Errors[0].Code
		e.Message = body.Errors[0].Message
	}
	return e
}

// drain reads and closes a body so the connection can be reused.
func drain(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
}
