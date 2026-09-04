// Credentials: registry token signing keys managed from the admin panel.
// registryd reads this table (registryd/internal/store/signingkeys.go) —
// keep the SQL there in sync with the columns here.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * ES256 key pairs the web app signs registry JWTs with. The newest key that
 * is not retired signs (its kid goes into the JWT header); every key that is
 * not retired — plus those retired less than ten minutes ago, the token TTL
 * with margin — verifies. When the table holds no active key the app falls
 * back to the file-based key (JWT_PRIVATE_KEY_FILE), which registryd always
 * trusts as well. The private key is AES-GCM encrypted under a key derived
 * from AUTH_SECRET (lib/crypto.ts): the database alone cannot sign tokens.
 */
export const tokenSigningKeys = pgTable("token_signing_keys", {
  /** Hex SHA-256 of the public key's PKIX DER — the same value registryd reports as fingerprint. */
  kid: text("kid").primaryKey(),
  publicKeyPem: text("public_key_pem").notNull(),
  privateKeyEncrypted: text("private_key_encrypted").notNull(),
  algorithm: text("algorithm").notNull().default("ES256"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
});
