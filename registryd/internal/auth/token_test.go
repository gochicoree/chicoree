package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestPublicKeyFingerprint(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	got := PublicKeyFingerprint(&key.PublicKey)
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	sum := sha256.Sum256(der)
	if want := hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("fingerprint = %s, want %s", got, want)
	}
	if len(got) != 64 {
		t.Fatalf("fingerprint length = %d, want 64 hex chars", len(got))
	}
	// Stable for the same key, different for another one.
	if PublicKeyFingerprint(&key.PublicKey) != got {
		t.Fatal("fingerprint is not deterministic")
	}
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if PublicKeyFingerprint(&other.PublicKey) == got {
		t.Fatal("different keys share a fingerprint")
	}
	if PublicKeyFingerprint("not a key") != "" {
		t.Fatal("unmarshalable input should yield an empty fingerprint")
	}
	v := &Verifier{disabled: true}
	if v.PublicKeyFingerprint() != "" {
		t.Fatal("disabled verifier should report no fingerprint")
	}
}

// --- multi-key verification ---------------------------------------------------

type memSource struct {
	keys []SigningKey
	err  error
	// calls counts SigningKeys invocations (refresh-on-miss checks).
	calls int
}

func (m *memSource) SigningKeys(_ context.Context, retiredAfter time.Time) ([]SigningKey, error) {
	m.calls++
	if m.err != nil {
		return nil, m.err
	}
	var out []SigningKey
	for _, k := range m.keys {
		if k.RetiredAt == nil || k.RetiredAt.After(retiredAfter) {
			out = append(out, k)
		}
	}
	return out, nil
}

func genKey(t *testing.T) (*ecdsa.PrivateKey, string, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return priv, string(pemBytes), PublicKeyFingerprint(&priv.PublicKey)
}

func newTestVerifier(t *testing.T, now func() time.Time) (*Verifier, *ecdsa.PrivateKey, string) {
	t.Helper()
	filePriv, filePEM, fileKid := genKey(t)
	path := filepath.Join(t.TempDir(), "key.pub")
	if err := os.WriteFile(path, []byte(filePEM), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := NewVerifier(path, "http://web/token", "svc", "iss", false)
	if err != nil {
		t.Fatal(err)
	}
	v.now = now
	return v, filePriv, fileKid
}

func signToken(t *testing.T, priv *ecdsa.PrivateKey, kid string, now time.Time) string {
	t.Helper()
	claims := &Claims{
		Access: []AccessGrant{{Type: "repository", Name: "acme/app", Actions: []string{"pull"}}},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "iss",
			Audience:  jwt.ClaimStrings{"svc"},
			Subject:   "user:1",
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-10 * time.Second)),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func identify(v *Verifier, token string) (*Identity, error) {
	r := httptest.NewRequest(http.MethodGet, "/v2/acme/app/manifests/latest", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	return v.Identify(r)
}

func TestVerifierKidSelection(t *testing.T) {
	now := time.Now()
	v, filePriv, fileKid := newTestVerifier(t, func() time.Time { return now })
	dbPriv, dbPEM, dbKid := genKey(t)
	src := &memSource{keys: []SigningKey{{Kid: dbKid, PublicKeyPEM: dbPEM}}}
	v.UseKeySource(src, 0)
	if err := v.RefreshKeys(context.Background()); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		token string
		ok    bool
	}{
		{"file key with its kid", signToken(t, filePriv, fileKid, now), true},
		{"file key without kid (legacy)", signToken(t, filePriv, "", now), true},
		{"database key by kid", signToken(t, dbPriv, dbKid, now), true},
		{"database key claiming the file kid", signToken(t, dbPriv, fileKid, now), false},
		{"file key claiming the database kid", signToken(t, filePriv, dbKid, now), false},
		{"unknown kid", signToken(t, dbPriv, "nope", now), false},
	}
	for _, c := range cases {
		id, err := identify(v, c.token)
		if c.ok && (err != nil || id == nil || !id.Can("repository", "acme/app", "pull")) {
			t.Errorf("%s: want accepted, got id=%v err=%v", c.name, id, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: want rejected, got identity %+v", c.name, id)
		}
	}
	if !v.disabled && len(v.PublicKeyFingerprints()) != 2 {
		t.Fatalf("PublicKeyFingerprints = %v, want file + database key", v.PublicKeyFingerprints())
	}
	if v.PublicKeyFingerprint() != fileKid {
		t.Fatalf("PublicKeyFingerprint = %s, want the file key %s", v.PublicKeyFingerprint(), fileKid)
	}
}

func TestVerifierRetiredKeyDrop(t *testing.T) {
	base := time.Now()
	current := base
	v, _, _ := newTestVerifier(t, func() time.Time { return current })
	dbPriv, dbPEM, dbKid := genKey(t)
	retired := base.Add(-time.Minute)
	src := &memSource{keys: []SigningKey{{Kid: dbKid, PublicKeyPEM: dbPEM, RetiredAt: &retired}}}
	v.UseKeySource(src, 10*time.Minute)
	if err := v.RefreshKeys(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Retired a minute ago: still inside the drop window.
	if _, err := identify(v, signToken(t, dbPriv, dbKid, base)); err != nil {
		t.Fatalf("recently retired key should still verify: %v", err)
	}
	keys := v.TrustedKeys()
	if len(keys) != 2 || keys[1].Source != "database" || keys[1].RetiredAt == nil {
		t.Fatalf("TrustedKeys = %+v, want file + retired database key", keys)
	}
	// Eleven minutes after retirement the key is dropped even before the next reload…
	current = retired.Add(11 * time.Minute)
	_, err := identify(v, signToken(t, dbPriv, dbKid, base))
	if err == nil {
		t.Fatal("key retired longer than the drop window must be rejected")
	}
	if !errors.Is(err, errUnknownKid) {
		t.Fatalf("want unknown-kid error, got %v", err)
	}
	if got := v.TrustedKeys(); len(got) != 1 {
		t.Fatalf("dropped key still listed: %+v", got)
	}
	// …and the reload no longer fetches it at all.
	if err := v.RefreshKeys(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(v.dbKeys) != 0 {
		t.Fatalf("reload kept a key retired outside the window: %v", v.dbKeys)
	}
}

func TestVerifierRefreshOnUnknownKid(t *testing.T) {
	base := time.Now()
	current := base
	v, _, _ := newTestVerifier(t, func() time.Time { return current })
	src := &memSource{}
	v.UseKeySource(src, 0)
	if err := v.RefreshKeys(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A key generated after the last reload: the first token naming it
	// triggers a refresh (the last one is older than the minimum interval).
	dbPriv, dbPEM, dbKid := genKey(t)
	src.keys = []SigningKey{{Kid: dbKid, PublicKeyPEM: dbPEM}}
	current = base.Add(time.Minute)
	callsBefore := src.calls
	if _, err := identify(v, signToken(t, dbPriv, dbKid, base)); err != nil {
		t.Fatalf("token with a freshly generated key should verify after the on-miss refresh: %v", err)
	}
	if src.calls != callsBefore+1 {
		t.Fatalf("expected exactly one refresh, got %d", src.calls-callsBefore)
	}
	// Unknown kids inside the minimum interval do not hammer the database.
	otherPriv, _, otherKid := genKey(t)
	if _, err := identify(v, signToken(t, otherPriv, otherKid, base)); err == nil {
		t.Fatal("unknown key must be rejected")
	}
	if src.calls != callsBefore+1 {
		t.Fatalf("a second miss within %s must not refresh again (calls=%d)", minRefreshInterval, src.calls-callsBefore)
	}
	// A failing source keeps the previous keys.
	src.err = errors.New("db down")
	current = current.Add(time.Minute)
	if err := v.RefreshKeys(context.Background()); err == nil {
		t.Fatal("expected refresh error")
	}
	if _, err := identify(v, signToken(t, dbPriv, dbKid, base)); err != nil {
		t.Fatalf("previous keys must survive a failed reload: %v", err)
	}
}

func TestVerifierWithoutKeySource(t *testing.T) {
	now := time.Now()
	v, filePriv, fileKid := newTestVerifier(t, func() time.Time { return now })
	if err := v.RefreshKeys(context.Background()); err != nil {
		t.Fatalf("refresh without a source must be a no-op: %v", err)
	}
	if _, err := identify(v, signToken(t, filePriv, fileKid, now)); err != nil {
		t.Fatalf("file key must verify in file-only mode: %v", err)
	}
	if got := v.PublicKeyFingerprints(); len(got) != 1 || got[0] != fileKid {
		t.Fatalf("fingerprints = %v, want only the file key", got)
	}
	if _, err := identify(v, signToken(t, filePriv, "some-db-kid", now)); err == nil {
		t.Fatal("unknown kid must be rejected without a key source")
	}
}
