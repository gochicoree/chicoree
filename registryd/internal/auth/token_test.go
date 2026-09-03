package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"testing"
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
