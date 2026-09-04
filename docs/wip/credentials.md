# Credentials: token lifecycle, signing-key rotation, session hygiene

Ready-to-fold sections for `README.md` (part A) and `ARCHITECTURE.md` (part B).

---

## A. README sections

### Personal access tokens

*Settings → Access tokens* creates the credentials you `docker login` with.
Besides a name and the scope (*read & write* or *read only*) a token has:

- **Expiry** — 7, 30, 90 or 365 days, a custom date, or *Never*. The
  instance can cap the lifetime and forbid *Never* (below); the form only
  offers what the policy allows and says so.
- **Organization** — optionally limit the token to one of your
  organizations. Whatever your roles allow elsewhere, a scope outside that
  organization is simply not granted, and the token cannot use the jobs API
  or list the catalog even when you are an administrator.
- **Repositories** — within that organization, tick the repositories the
  token may touch. A repository-limited token cannot create new repositories
  on push.
- **Description** — free text, shown in the list.

The list shows every token with its scope, expiry state (*expires in N
days* turns red inside the last week; expired tokens are greyed out and can
be deleted), the last use with time and client address, and where it may be
used. **Rotate** creates a replacement with the same name, scope,
restriction and lifetime, shows the new secret once, and revokes the old one
immediately. Service accounts (*Organization → Service accounts*) get the
same expiry choices, last-use address and a *Rotate* action that swaps the
secret in place (same name and id, so pipelines only need the new secret).

Seven days before a token or service account expires its owner — the user,
or the organization's owners and admins — receives one email
(*Settings → Notifications → Credential expiring*). The reminder is sent by
the `token-expiry` job; schedule it daily on *Administration → Jobs*.

### Token policy

*Administration → Auth providers → Access* (or the environment defaults)
sets the rules every new token and service account must follow:

| Setting | Meaning | Environment default |
| --- | --- | --- |
| Longest lifetime (days) | Caps the presets and custom dates offered; 0 = unlimited | `TOKEN_MAX_LIFETIME_DAYS=0` |
| Every token must expire | Removes *Never*; a request without an expiry is refused | `TOKEN_REQUIRE_EXPIRY=false` |

The server enforces both regardless of what a form posts. Existing
credentials are never shortened.

Administrators see every user's tokens on *Administration → Users → user*
with a revoke button, plus a *Revoke all sessions* button for the account,
and the *Administration* overview counts the credentials expiring within
seven days, never expiring and already expired.

### Signing-key rotation

Registry tokens are five-minute JWTs signed with an ES256 key. Out of the
box that is the file key pair from `scripts/gen-keys.sh`
(`JWT_PRIVATE_KEY_FILE` for the web app, `JWT_PUBLIC_KEY_FILE` for the
registry) and nothing else is needed. *Administration → Signing keys* lets
you rotate without downtime:

1. **Generate new key.** It signs every token from now on (its id travels in
   the JWT header). The registry learns about it within 60 seconds — or at
   once, when the first token naming it arrives — and keeps trusting the
   previous key.
2. **Wait longer than five minutes**, the token lifetime, so every token
   signed with the old key has expired. *Administration → Health* shows
   whether the registry trusts the active key.
3. **Retire the old key.** Retiring is refused for the key that signs right
   now. Ten minutes after retirement the registry drops it and rejects
   anything still signed with it.

The page lists each key with its fingerprint, when it was created, activated
and retired, which one signs now, and whether the registry trusts it; the
file key is listed too and is always trusted. Private keys are stored
AES-GCM encrypted under a key derived from `AUTH_SECRET`; if that secret
changes the stored keys become unusable and the app falls back to the file
key. Every generate and retire is in the audit log.

### Sessions

*Settings → Security* lists every signed-in browser and device with its
address, user agent, start, last activity and expiry. *Sign out everywhere
else* revokes all sessions but the current one; administrators can revoke
all sessions of an account from its user page. Both are audited.

---

## B. ARCHITECTURE notes

### Schema

- `access_tokens` gains `last_used_ip text`, `description text not null
  default ''`, `organization_id text null` (FK organization, on delete
  cascade — a token limited to a deleted organization goes with it) and
  `repository_ids jsonb null` (same shape as service accounts).
- `service_accounts` gains `last_used_ip text`.
- New table `token_signing_keys` (`web/src/db/credentials-schema.ts`, re-
  exported from `schema.ts`): `kid text PK` (= hex SHA-256 of the PKIX DER of
  the public key, the fingerprint convention `/internal/v1/status` already
  used), `public_key_pem`, `private_key_encrypted` (`lib/crypto.ts`
  `encryptSecret`, key derived from `AUTH_SECRET`), `algorithm` (`ES256`),
  `created_at`, `activated_at`, `retired_at null`, `created_by` (FK user,
  set null). registryd reads it in
  `registryd/internal/store/signingkeys.go` (`SigningKeys(ctx,
  retiredAfter)`): active keys plus those retired after the cutoff, newest
  first.
- No custom migration SQL: every new column is nullable or has a default;
  the new table starts empty (= file-key mode).

### Token lifecycle

- **Pure rules** in `lib/token-policy-shared.ts` (browser-safe):
  `expiryOptions(policy)` / `defaultExpiryChoice` / `describeExpiryPolicy`
  drive the forms; `resolveExpiry(choice, customDate, policy)` is the single
  server-side validator (presets, custom date, *never*, the lifetime cap with
  a one-minute tolerance); `expiryState` / `describeExpiry` / `isExpired`
  for lists and checks; `normalizeRestriction` / `restrictionAllows` /
  `describeRestriction` for the organization / repository limits;
  `lastUsedText` for lists.
- **Policy** lives in the existing `access` settings section
  (`lib/instance-settings.ts`, `lib/access-shared.ts`): `maxTokenLifetimeDays`
  (0 = unlimited) and `requireTokenExpiry`, env defaults
  `TOKEN_MAX_LIFETIME_DAYS` / `TOKEN_REQUIRE_EXPIRY` (`lib/env.ts`), saved
  from the Access tab (`app/actions/admin-platform.ts#saveAccessSettings`,
  `admin/auth/access/access-form.tsx`). Older stored `access` rows without
  the new fields fall back to the env defaults through the section merge.
- **Identification** `lib/credential-auth.ts`: `identifyAccessToken(secret,
  ip)` and `identifyServiceAccount(secret, ip)` look the credential up by
  hash, refuse expired ones (`isExpired`), banned / missing accounts, attach
  the PAT's restriction to the `Caller` (`lib/access.ts`:
  `restriction?: TokenRestriction | null`) and record the use.
  `touchAccessToken` / `touchServiceAccount` write `last_used_at` and
  `last_used_ip` with `WHERE last_used_at IS NULL OR last_used_at < now() -
  interval '5 minutes'` — one throttled UPDATE, fire-and-forget.
  `expiringCredentials(days)` and `credentialStats()` feed the job and the
  admin overview card.
- **Enforcement**: `allowedRepositoryActions` (`lib/access.ts`) empties the
  grant when `restrictionAllows` fails for `<org id, repo id | null>` (a
  repository-limited token never gets a not-yet-existing repository, so no
  auto-create); `mayAccessCatalog` refuses restricted tokens; the token route
  (`app/api/registry/token/route.ts`) now calls the two identify helpers and
  skips the automatic admin catalog grant for restricted tokens — the rest of
  the route is untouched. `lib/jobs-auth.ts#authenticateJobsRequest(auth,
  headers?)` uses `identifyAccessToken` too (expiry, last use + IP) and
  refuses restricted tokens; the jobs / mirror-preview routes pass
  `req.headers` for the address.
- **Actions** `app/actions/credentials.ts`: `createAccessToken` (name,
  description, scope, `expires` + `expiresOn`, `organizationId`,
  `repositoryIds[]` — membership and repository ownership verified),
  `rotateAccessToken` (transaction: insert the replacement with the same
  settings and the original lifetime counted from now, capped by the current
  policy; delete the old row; audit `token.rotate` with `replaced`),
  `deleteAccessToken`, `adminRevokeAccessToken` (admin, audit
  `admin.token.revoke`), `createServiceAccount` (same expiry rules),
  `rotateServiceAccount` (new hash in place, same id, audit `sa.rotate`).
  Every mutation goes through `recordAudit`.
- **UI**: `settings/tokens/page.tsx` + `token-manager.tsx` (shared
  `ExpiryFields`, `ExpiryBadge`, `SecretPanel`; rotate through a
  `ConfirmModal`, the new secret in a `Modal`), `lib/credentials-data.ts#
  loadUserTokens` (restriction resolved to names; also used by
  `admin/users/[id]/page.tsx`, which lists the tokens with revoke and gains
  *Revoke all sessions* in `user-controls.tsx` via
  `authClient.admin.revokeUserSessions`), `[org]/service-accounts/sa-manager.tsx`,
  the credentials card on `admin/page.tsx`.
- **Reminders**: notification event `token.expiring` (scope `account`;
  `lib/notify-shared.ts`, `lib/notify.ts`: PAT → the owner, SA → the
  organization's owners/admins; the notifications form shows account-scoped
  events to everyone). Job `token-expiry` (`lib/jobs.ts` → `lib/token-expiry.ts`,
  param `withinDays`, default 7): claims `notification_state` key
  `token.expiring:<pat|sa>:<id>` with `INSERT … ON CONFLICT DO NOTHING
  RETURNING` so each credential is warned once; a rotated PAT is a new row
  (new reminder); a rotated SA keeps its id, so state rows whose expiry left
  the window are deleted at the end of a run.

### Signing keys

- `lib/signing-keys.ts`: `generateSigningKey` (P-256 pair via
  `generateKeyPairSync`, kid = fingerprint, private PEM encrypted,
  `activated_at = now`), `retireSigningKey` (refused for the newest active
  key), `listSigningKeys`, `fileKeyInfo`, `trustedFingerprints`,
  `activeSigner()` — the newest active database key (decrypted and parsed
  once per kid), else the file key with kid = its fingerprint. The lookup
  runs on every token request (one indexed row) so all replicas switch on
  the next request. `privateKeyFingerprint` moved here from `lib/health.ts`
  (re-exported there).
- `lib/registry-jwt.ts#signRegistryToken` sets the protected header
  `{ alg: ES256, typ: JWT, kid }` and returns the kid.
- Actions `app/actions/signing-keys.ts` (`generateSigningKeyAction`,
  `retireSigningKeyAction`; audit `keys.generate` / `keys.retire`); page
  `admin/settings/keys` (tab *Signing keys* in `admin-nav.tsx`) with
  `keys-manager.tsx`; the registry's trusted set comes from
  `registryStatus()` (`lib/registry-client.ts`: `RegistryStatus` gains
  `publicKeyFingerprints` and `trustedKeys[]`).
- **registryd** `internal/auth/token.go`: the `Verifier` keeps the file key
  (`fileKid` = fingerprint) plus a map of database keys loaded through a
  `KeySource` (adapter over `store.SigningKeys` in `cmd/registryd/main.go`).
  The JWT keyfunc resolves `kid`: empty or the file fingerprint → file key;
  else a database key that is active or retired less than the drop window
  ago; else `errUnknownKid`. `Identify` refreshes the keys once on an
  unknown kid (at most every 5 s) and retries, so a key generated a moment
  ago works immediately. `RunKeyReload` polls every
  `TOKEN_KEY_RELOAD_INTERVAL` (default 60 s, minimum 5 s); the drop window
  is `TOKEN_KEY_DROP_WINDOW` (default 10 m, minimum 5 m) — both in
  `internal/config`. A failing reload keeps the previous keys. `TrustedKeys`
  / `PublicKeyFingerprints` feed `/internal/v1/status`
  (`publicKeyFingerprints`, `trustedKeys[{kid, fingerprint, source,
  retiredAt}]`; `publicKeyFingerprint` stays the file key for older web
  builds). Tests: kid selection, legacy tokens without kid, wrong kid for a
  key, unknown kid, retired-key drop before and after reload, refresh on
  miss with rate limiting, failing source, file-only mode, config parsing.
- **Health** (`lib/health.ts#checkTokenKeys`): green when the active
  signer's kid is among the registry's trusted fingerprints; distinguishes
  "registry has not picked up the new key yet" (reloads every 60 s) from a
  real mismatch; shows file key, signer, database key counts and the
  trusted list.

### Sessions

`settings/security/page.tsx` passes `updatedAt` (last activity) and
`expiresAt` from `auth.api.listSessions`; `SessionsList`
(`settings/profile-forms.tsx`) shows address, user agent, start, last
activity and expiry, and *Sign out everywhere else* calls
`authClient.revokeOtherSessions()`. The admin user page calls
`authClient.admin.revokeUserSessions`. Both routes were already audited by
`lib/auth-audit.ts` (`auth.session.revoke` with scope
`revoke-other-sessions`, `admin.user.revoke_sessions`).

### Environment variables added

Web: `TOKEN_MAX_LIFETIME_DAYS`, `TOKEN_REQUIRE_EXPIRY` (`.env.example`,
`docker-compose.yml`). registryd: `TOKEN_KEY_RELOAD_INTERVAL` (default
`60s`), `TOKEN_KEY_DROP_WINDOW` (default `10m`) — optional, not in compose.

### Audit actions added

`token.rotate`, `admin.token.revoke`, `sa.rotate`, `keys.generate`,
`keys.retire` (plus details on `token.create`: organization, repository
count, expiry).
