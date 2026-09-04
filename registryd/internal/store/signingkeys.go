package store

import (
	"context"
	"time"
)

// SigningKey is a row of token_signing_keys (web/src/db/credentials-schema.ts):
// a public key the web app may sign registry tokens with. registryd never
// needs the encrypted private half.
type SigningKey struct {
	Kid          string
	PublicKeyPEM string
	RetiredAt    *time.Time
}

// SigningKeys returns every key that is active or was retired after
// retiredAfter (the overlap window: tokens signed just before retirement
// are still in flight). Newest first.
func (s *Store) SigningKeys(ctx context.Context, retiredAfter time.Time) ([]SigningKey, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kid, public_key_pem, retired_at
		FROM token_signing_keys
		WHERE retired_at IS NULL OR retired_at > $1
		ORDER BY created_at DESC`, retiredAfter)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SigningKey
	for rows.Next() {
		var k SigningKey
		if err := rows.Scan(&k.Kid, &k.PublicKeyPEM, &k.RetiredAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}
