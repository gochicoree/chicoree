// Package auth validates Docker Registry v2 bearer tokens issued by the web
// application's token service. Tokens are ES256-signed JWTs carrying an
// "access" claim listing the resource grants the holder was authorized for.
//
// Several keys can be trusted at once: the file key from JWT_PUBLIC_KEY_FILE
// (always) plus the keys the admin panel generated into token_signing_keys.
// The JWT header's kid names the signer; a token without kid is verified
// with the file key. Retired keys stay trusted for a drop window (ten
// minutes, twice the token lifetime) so a rotation never invalidates tokens
// that are still in flight.
package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// AccessGrant is a single resource authorization inside a token.
type AccessGrant struct {
	Type    string   `json:"type"` // "repository" or "registry"
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

// Claims is the token payload the web app signs.
type Claims struct {
	Access []AccessGrant `json:"access"`
	jwt.RegisteredClaims
}

// Identity describes the authenticated caller of a registry request.
type Identity struct {
	// Subject is e.g. "user:<id>", "sa:<id>", "mirror:<id>" or "anonymous".
	Subject string
	Access  []AccessGrant
}

// ActorType splits the subject prefix ("user", "sa", "anonymous").
func (id *Identity) ActorType() string {
	if id == nil || id.Subject == "" || id.Subject == "anonymous" {
		return "anonymous"
	}
	t, _, ok := strings.Cut(id.Subject, ":")
	if !ok {
		return "anonymous"
	}
	switch t {
	case "user", "sa", "mirror":
		return t
	}
	return "anonymous"
}

// ActorID returns the id portion of the subject, or "" for anonymous.
func (id *Identity) ActorID() string {
	if id == nil {
		return ""
	}
	_, v, ok := strings.Cut(id.Subject, ":")
	if !ok {
		return ""
	}
	return v
}

// Can reports whether the identity holds the given action on the resource.
func (id *Identity) Can(resourceType, name, action string) bool {
	if id == nil {
		return false
	}
	for _, g := range id.Access {
		if g.Type != resourceType || g.Name != name {
			continue
		}
		if slices.Contains(g.Actions, action) || slices.Contains(g.Actions, "*") {
			return true
		}
	}
	return false
}

// SigningKey is a public key from the database (token_signing_keys).
type SigningKey struct {
	Kid          string
	PublicKeyPEM string
	// RetiredAt is nil while the key is active.
	RetiredAt *time.Time
}

// KeySource lists database keys that are active or retired after the given
// time. The store implements it through an adapter in main.
type KeySource interface {
	SigningKeys(ctx context.Context, retiredAfter time.Time) ([]SigningKey, error)
}

// KeySourceFunc adapts a function to KeySource.
type KeySourceFunc func(ctx context.Context, retiredAfter time.Time) ([]SigningKey, error)

func (f KeySourceFunc) SigningKeys(ctx context.Context, retiredAfter time.Time) ([]SigningKey, error) {
	return f(ctx, retiredAfter)
}

// TrustedKeyInfo describes one key the verifier accepts, for /internal/v1/status.
type TrustedKeyInfo struct {
	Kid         string  `json:"kid"`
	Fingerprint string  `json:"fingerprint"`
	Source      string  `json:"source"` // "file" or "database"
	RetiredAt   *string `json:"retiredAt"`
}

// DefaultDropWindow is how long a retired key stays trusted.
const DefaultDropWindow = 10 * time.Minute

// minRefreshInterval limits how often an unknown kid triggers a database read.
const minRefreshInterval = 5 * time.Second

var errUnknownKid = errors.New("unknown signing key")

type trustedKey struct {
	pub       *ecdsa.PublicKey
	retiredAt *time.Time
}

// Verifier validates bearer tokens and produces WWW-Authenticate challenges.
type Verifier struct {
	publicKey *ecdsa.PublicKey // the file key
	fileKid   string           // its fingerprint: the kid the web app uses for it
	realm     string
	service   string
	issuer    string
	disabled  bool

	mu          sync.RWMutex
	dbKeys      map[string]trustedKey
	source      KeySource
	dropWindow  time.Duration
	lastRefresh time.Time
	refreshMu   sync.Mutex
	now         func() time.Time
}

// NewVerifier loads the ES256 public key from pemPath. When disabled is true
// every request is treated as an admin (dev only).
func NewVerifier(pemPath, realm, service, issuer string, disabled bool) (*Verifier, error) {
	v := &Verifier{realm: realm, service: service, issuer: issuer, disabled: disabled,
		dbKeys: map[string]trustedKey{}, dropWindow: DefaultDropWindow, now: time.Now}
	if disabled {
		return v, nil
	}
	raw, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("read token public key: %w", err)
	}
	ec, err := ParsePublicKeyPEM(raw)
	if err != nil {
		return nil, fmt.Errorf("token public key %s: %w", pemPath, err)
	}
	v.publicKey = ec
	v.fileKid = PublicKeyFingerprint(ec)
	return v, nil
}

// ParsePublicKeyPEM decodes a PEM-encoded PKIX ECDSA (P-256) public key.
func ParsePublicKeyPEM(raw []byte) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("no PEM block found")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key must be ECDSA (ES256), got %T", pub)
	}
	return ec, nil
}

// Disabled reports whether auth enforcement is off.
func (v *Verifier) Disabled() bool { return v.disabled }

// UseKeySource enables database keys: RefreshKeys reads them, RunKeyReload
// keeps them current, and an unknown kid triggers an immediate re-read.
// dropWindow <= 0 keeps the default.
func (v *Verifier) UseKeySource(src KeySource, dropWindow time.Duration) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.source = src
	if dropWindow > 0 {
		v.dropWindow = dropWindow
	}
}

// DropWindow is how long a retired key stays trusted.
func (v *Verifier) DropWindow() time.Duration { return v.dropWindow }

// RefreshKeys re-reads the database keys. Keys retired longer ago than the
// drop window are excluded; unparsable keys are skipped with a warning.
func (v *Verifier) RefreshKeys(ctx context.Context) error {
	v.mu.RLock()
	src := v.source
	window := v.dropWindow
	v.mu.RUnlock()
	if src == nil {
		return nil
	}
	now := v.now()
	rows, err := src.SigningKeys(ctx, now.Add(-window))
	if err != nil {
		return err
	}
	next := make(map[string]trustedKey, len(rows))
	for _, r := range rows {
		pub, err := ParsePublicKeyPEM([]byte(r.PublicKeyPEM))
		if err != nil {
			slog.Warn("auth: skipping unusable signing key", "kid", r.Kid, "err", err)
			continue
		}
		next[r.Kid] = trustedKey{pub: pub, retiredAt: r.RetiredAt}
	}
	v.mu.Lock()
	changed := len(next) != len(v.dbKeys)
	if !changed {
		for kid := range next {
			if _, ok := v.dbKeys[kid]; !ok {
				changed = true
				break
			}
		}
	}
	v.dbKeys = next
	v.lastRefresh = now
	v.mu.Unlock()
	if changed {
		slog.Info("auth: signing keys reloaded", "databaseKeys", len(next))
	}
	return nil
}

// RunKeyReload polls the key source every interval until ctx is done.
func (v *Verifier) RunKeyReload(ctx context.Context, interval time.Duration) {
	if v.source == nil || interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			loadCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := v.RefreshKeys(loadCtx); err != nil {
				slog.Warn("auth: signing key reload failed; keeping the previous keys", "err", err)
			}
			cancel()
		}
	}
}

// refreshOnMiss re-reads keys after an unknown kid, at most once per
// minRefreshInterval. Reports whether a refresh happened.
func (v *Verifier) refreshOnMiss(ctx context.Context) bool {
	v.mu.RLock()
	src := v.source
	last := v.lastRefresh
	v.mu.RUnlock()
	if src == nil || v.now().Sub(last) < minRefreshInterval {
		return false
	}
	v.refreshMu.Lock()
	defer v.refreshMu.Unlock()
	if err := v.RefreshKeys(ctx); err != nil {
		slog.Warn("auth: signing key refresh after unknown kid failed", "err", err)
		return false
	}
	return true
}

// keyFor resolves the verification key for a token header kid. Empty kid or
// the file key's fingerprint selects the file key; otherwise a database key
// that is active or retired within the drop window.
func (v *Verifier) keyFor(kid string) (*ecdsa.PublicKey, error) {
	if kid == "" || kid == v.fileKid {
		return v.publicKey, nil
	}
	v.mu.RLock()
	k, ok := v.dbKeys[kid]
	window := v.dropWindow
	v.mu.RUnlock()
	if !ok {
		return nil, errUnknownKid
	}
	if k.retiredAt != nil && v.now().Sub(*k.retiredAt) > window {
		return nil, fmt.Errorf("%w: retired", errUnknownKid)
	}
	return k.pub, nil
}

// PublicKeyFingerprint identifies the file key: the hex SHA-256 of its PKIX
// (SubjectPublicKeyInfo) DER encoding. Kept for older health pages; see
// TrustedKeys for the complete set. Empty when auth is disabled.
func (v *Verifier) PublicKeyFingerprint() string {
	if v.publicKey == nil {
		return ""
	}
	return v.fileKid
}

// TrustedKeys lists every key that verifies tokens right now: the file key
// and the database keys inside the drop window, sorted file first then by kid.
func (v *Verifier) TrustedKeys() []TrustedKeyInfo {
	if v.disabled {
		return nil
	}
	out := []TrustedKeyInfo{{Kid: v.fileKid, Fingerprint: v.fileKid, Source: "file"}}
	v.mu.RLock()
	now := v.now()
	kids := make([]string, 0, len(v.dbKeys))
	for kid, k := range v.dbKeys {
		if k.retiredAt != nil && now.Sub(*k.retiredAt) > v.dropWindow {
			continue
		}
		kids = append(kids, kid)
	}
	sort.Strings(kids)
	for _, kid := range kids {
		k := v.dbKeys[kid]
		info := TrustedKeyInfo{Kid: kid, Fingerprint: PublicKeyFingerprint(k.pub), Source: "database"}
		if k.retiredAt != nil {
			s := k.retiredAt.UTC().Format(time.RFC3339)
			info.RetiredAt = &s
		}
		out = append(out, info)
	}
	v.mu.RUnlock()
	return out
}

// PublicKeyFingerprints is the fingerprint of every trusted key.
func (v *Verifier) PublicKeyFingerprints() []string {
	keys := v.TrustedKeys()
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k.Fingerprint)
	}
	return out
}

// PublicKeyFingerprint is the hex SHA-256 over the PKIX DER form of a key.
func PublicKeyFingerprint(pub any) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// Identify parses the Authorization header. A missing header yields (nil, nil)
// — an unauthenticated request. A present-but-invalid token yields an error.
func (v *Verifier) Identify(r *http.Request) (*Identity, error) {
	if v.disabled {
		return &Identity{
			Subject: "user:dev",
			Access:  []AccessGrant{{Type: "registry", Name: "catalog", Actions: []string{"*"}}},
		}, nil
	}
	h := r.Header.Get("Authorization")
	if h == "" {
		return nil, nil
	}
	scheme, token, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return nil, fmt.Errorf("unsupported authorization scheme")
	}
	id, err := v.verify(token)
	if errors.Is(err, errUnknownKid) && v.refreshOnMiss(r.Context()) {
		// A key generated moments ago: the reload just fetched it.
		id, err = v.verify(token)
	}
	return id, err
}

func (v *Verifier) verify(token string) (*Identity, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodES256.Alg() {
			return nil, fmt.Errorf("unexpected signing method %s", t.Method.Alg())
		}
		kid, _ := t.Header["kid"].(string)
		return v.keyFor(kid)
	},
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.service),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil || !parsed.Valid {
		if err == nil {
			err = errors.New("token not valid")
		}
		return nil, fmt.Errorf("invalid token: %w", err)
	}
	return &Identity{Subject: claims.Subject, Access: claims.Access}, nil
}

// Challenge writes the WWW-Authenticate header instructing the client where
// to obtain a token for the given scope (may be empty for the base endpoint).
func (v *Verifier) Challenge(w http.ResponseWriter, scope string) {
	if v.disabled {
		return
	}
	c := fmt.Sprintf("Bearer realm=%q,service=%q", v.realm, v.service)
	if scope != "" {
		c += fmt.Sprintf(",scope=%q", scope)
	}
	w.Header().Set("WWW-Authenticate", c)
}

// RepositoryScope formats a scope string for a repository resource.
func RepositoryScope(name string, actions ...string) string {
	return fmt.Sprintf("repository:%s:%s", name, strings.Join(actions, ","))
}
