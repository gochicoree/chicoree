package config

import (
	"fmt"
	"os"
	"strconv"
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
	StagingDir    string // local scratch space for in-progress uploads

	// Token auth
	TokenRealm   string // absolute URL of the web token endpoint
	TokenService string // "service" value in the challenge / token audience
	TokenIssuer  string // expected "iss" claim
	JWTPublicKey string // path to PEM-encoded ES256 public key
	AuthDisabled bool   // dev escape hatch, never use in production

	// Webhook to the web app
	WebhookURL    string
	WebhookSecret string

	// Upload housekeeping
	UploadSessionTTL time.Duration
	// GCGracePeriod protects blobs uploaded moments ago (their manifest may
	// still be in flight) from garbage collection.
	GCGracePeriod time.Duration
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

		StorageDriver: env("STORAGE_DRIVER", "filesystem"),
		StagingDir:    env("STORAGE_STAGING_DIR", "/var/lib/registry/_uploads"),

		TokenRealm:   os.Getenv("TOKEN_REALM"),
		TokenService: env("TOKEN_SERVICE", "chicoree-registry"),
		TokenIssuer:  env("TOKEN_ISSUER", "chicoree-web"),
		JWTPublicKey: env("JWT_PUBLIC_KEY_FILE", "/run/secrets/registry-token.pub"),
		AuthDisabled: envBool("AUTH_DISABLED", false),

		WebhookURL:    os.Getenv("WEBHOOK_URL"),
		WebhookSecret: os.Getenv("WEBHOOK_SECRET"),

		UploadSessionTTL: envDuration("UPLOAD_SESSION_TTL", 24*time.Hour),
		GCGracePeriod:    envDuration("GC_GRACE_PERIOD", time.Hour),
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if !c.AuthDisabled && c.TokenRealm == "" {
		return nil, fmt.Errorf("TOKEN_REALM is required unless AUTH_DISABLED=true")
	}
	return c, nil
}
