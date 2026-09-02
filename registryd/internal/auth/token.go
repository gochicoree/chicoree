// Package auth validates Docker Registry v2 bearer tokens issued by the web
// application's token service. Tokens are ES256-signed JWTs carrying an
// "access" claim listing the resource grants the holder was authorized for.
package auth

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
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

// Verifier validates bearer tokens and produces WWW-Authenticate challenges.
type Verifier struct {
	publicKey *ecdsa.PublicKey
	realm     string
	service   string
	issuer    string
	disabled  bool
}

// NewVerifier loads the ES256 public key from pemPath. When disabled is true
// every request is treated as an admin (dev only).
func NewVerifier(pemPath, realm, service, issuer string, disabled bool) (*Verifier, error) {
	v := &Verifier{realm: realm, service: service, issuer: issuer, disabled: disabled}
	if disabled {
		return v, nil
	}
	raw, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("read token public key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("token public key %s: no PEM block found", pemPath)
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse token public key: %w", err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("token public key must be ECDSA (ES256), got %T", pub)
	}
	v.publicKey = ec
	return v, nil
}

// Disabled reports whether auth enforcement is off.
func (v *Verifier) Disabled() bool { return v.disabled }

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
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodES256.Alg() {
			return nil, fmt.Errorf("unexpected signing method %s", t.Method.Alg())
		}
		return v.publicKey, nil
	},
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.service),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil || !parsed.Valid {
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
