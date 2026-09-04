package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration for registryd. Every value is
// sourced from the environment so the binary works identically in compose,
// k8s, or bare-metal deployments.
type Config struct {
	ListenAddr string
	LogFormat  string // "text" or "json"

	DatabaseURL string

	// Storage: the plugin name; plugin options come from <NAME>_* env vars.
	StorageDriver string
	// StorageStaging selects where in-flight uploads live: "local" (files
	// under StagingDir, node-local) or "shared" (sessions in Postgres, chunks
	// in the storage backend, so any replica can serve any upload request).
	StorageStaging string
	StagingDir     string // local scratch space for in-progress uploads

	// Token auth
	TokenRealm   string // absolute URL of the web token endpoint
	TokenService string // "service" value in the challenge / token audience
	TokenIssuer  string // expected "iss" claim
	JWTPublicKey string // path to PEM-encoded ES256 public key
	AuthDisabled bool   // dev escape hatch, never use in production

	// Webhook to the web app
	WebhookURL    string
	WebhookSecret string
	// InternalAPIURL is the base of the web app's internal API
	// (…/api/internal); registryd reads proxy-cache configuration from it.
	// Defaults to WEBHOOK_URL with its last path segment dropped.
	InternalAPIURL string

	// Upload housekeeping
	UploadSessionTTL time.Duration
	// GCGracePeriod protects blobs uploaded moments ago (their manifest may
	// still be in flight) from garbage collection.
	GCGracePeriod time.Duration

	// Pull rate limits ("<count>/<window>", empty = unlimited) and the
	// proxies whose X-Forwarded-For is trusted. These are the fallback for
	// instances that never saved the "ratelimit" section in the admin panel.
	RateLimitAnonymous      string
	RateLimitAuthenticated  string
	RateLimitTrustedProxies string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

// Load reads configuration from the environment and validates it.
func Load() (*Config, error) {
	c := &Config{
		ListenAddr: env("REGISTRY_LISTEN_ADDR", ":5000"),
		LogFormat:  env("REGISTRY_LOG_FORMAT", "text"),

		DatabaseURL: os.Getenv("DATABASE_URL"),

		StorageDriver:  env("STORAGE_DRIVER", "filesystem"),
		StorageStaging: strings.ToLower(env("STORAGE_STAGING", "local")),
		StagingDir:     env("STORAGE_STAGING_DIR", "/var/lib/registry/_uploads"),

		TokenRealm:   os.Getenv("TOKEN_REALM"),
		TokenService: env("TOKEN_SERVICE", "chicoree-registry"),
		TokenIssuer:  env("TOKEN_ISSUER", "chicoree-web"),
		JWTPublicKey: env("JWT_PUBLIC_KEY_FILE", "/run/secrets/registry-token.pub"),
		AuthDisabled: envBool("AUTH_DISABLED", false),

		WebhookURL:     os.Getenv("WEBHOOK_URL"),
		WebhookSecret:  os.Getenv("WEBHOOK_SECRET"),
		InternalAPIURL: os.Getenv("INTERNAL_API_URL"),

		UploadSessionTTL: envDuration("UPLOAD_SESSION_TTL", 24*time.Hour),
		GCGracePeriod:    envDuration("GC_GRACE_PERIOD", time.Hour),

		RateLimitAnonymous:      os.Getenv("RATE_LIMIT_ANONYMOUS"),
		RateLimitAuthenticated:  os.Getenv("RATE_LIMIT_AUTHENTICATED"),
		RateLimitTrustedProxies: os.Getenv("RATE_LIMIT_TRUSTED_PROXIES"),
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if c.StorageStaging != "local" && c.StorageStaging != "shared" {
		return nil, fmt.Errorf("STORAGE_STAGING must be local or shared, got %q", c.StorageStaging)
	}
	if !c.AuthDisabled && c.TokenRealm == "" {
		return nil, fmt.Errorf("TOKEN_REALM is required unless AUTH_DISABLED=true")
	}
	if c.InternalAPIURL == "" {
		c.InternalAPIURL = DeriveInternalAPIURL(c.WebhookURL)
	}
	return c, nil
}

// DeriveInternalAPIURL turns http://web:3000/api/internal/events into
// http://web:3000/api/internal (the webhook is one route of that API).
func DeriveInternalAPIURL(webhookURL string) string {
	u := strings.TrimRight(strings.TrimSpace(webhookURL), "/")
	if u == "" {
		return ""
	}
	scheme, rest, ok := strings.Cut(u, "://")
	if !ok {
		return u
	}
	if i := strings.LastIndex(rest, "/"); i > 0 {
		return scheme + "://" + rest[:i]
	}
	return u
}
