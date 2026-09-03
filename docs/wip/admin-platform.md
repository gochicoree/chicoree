# Admin platform: audit log, sign-up controls, branding, health

Ready-to-fold sections for `README.md` (part A) and `ARCHITECTURE.md` (part B).

---

## A. README sections

### Audit log

Every change made through the app is recorded: sign-ins and sign-ups (and
failed attempts), password / two-factor / passkey changes, organization,
member and invitation changes, repository visibility and deletion, tag
deletion, access tokens and service accounts, webhooks, mirrors, pull
policies, admin actions (roles, bans, limits, impersonation), instance
settings and job runs. Each entry carries who (with the impersonating admin
when applicable), what, the target, the organization, a small redacted
details object, the client IP and user agent.

- **Instance-wide**: *Administration → Audit* (`/admin/audit`) — search over
  actor / target / action, filter by action group, organization and date
  range, 50 entries per page, expand a row for the details. *Export CSV*
  downloads the current filter (up to 10 000 rows) from
  `GET /api/admin/audit.csv?q=&action=&org=&from=&to=`.
- **Per organization**: owners and admins get an *Audit* tab next to
  *Members* (`/<org>/audit`) with the entries of that organization, and the
  same CSV export scoped to it.
- **Retention**: `AUDIT_RETENTION_DAYS` (default `365`). Older rows are
  pruned opportunistically (at most once an hour, when an entry is written).

### Sign-up controls

*Administration → Auth providers → Access* (or the environment defaults)
decides who can register:

| Setting | Values | Environment default |
| --- | --- | --- |
| Sign-up | `open` (anyone), `invite` (only through an organization invitation link), `closed` (no new accounts at all) | `SIGNUP_MODE=open` |
| Allowed email domains | list; empty = any. Subdomains are included. | `SIGNUP_ALLOWED_DOMAINS=` (comma-separated) |
| Organization creation | `everyone` or `admins` | `ORG_CREATION=everyone` |

The rules apply wherever an account comes into existence: the sign-up form,
magic-link and email-code sign-ups, the first GitHub / Google / OIDC login,
and LDAP provisioning (browser and `docker login`). Existing accounts are
never affected, and the very first account on an empty instance is always
allowed (someone has to become the administrator). In invitation-only mode
the invitation email's *Create an account* button still works for the invited
address; the sign-up page explains the situation otherwise, and the sign-in
page hides the *Create an account* link. When organization creation is
restricted, users see no *New organization* button and the API refuses.

### Branding and announcements

*Administration → Branding* (`/admin/branding`) sets the instance name and
tagline (page titles, sidebar, sign-in screens, emails), a PNG or SVG logo
(≤ 64 KB, replaces the chicory mark), the accent colour, up to six footer
links, and an announcement banner shown at the top of every page: `info` and
`warning` banners can be dismissed (remembered per browser until the text
changes), `danger` banners cannot. `INSTANCE_NAME` and `INSTANCE_TAGLINE`
are the environment defaults; the page previews changes live.

### Instance health

*Administration → Health* (`/admin/health`) runs live checks with a 3-second
timeout each: registryd (health, version, storage driver, uptime, blob count
and bytes, staging disk space), Postgres (size, connections, applied
migrations), Clair (liveness and updater freshness, or "not configured"),
the token signing keys (the app's private key vs. the public key registryd
trusts), pending / failed scans, failing webhooks, last run per job, failed
mirrors, and the last garbage collection. *Refresh* re-runs everything.

For uptime monitors, `GET /api/health` needs no credentials: it pings the
database and the registry and answers `200 {"status":"ok"}` or
`503 {"status":"degraded"}` with per-check latencies.

Registry builds can stamp a version into the health page:
`docker build --build-arg VERSION=1.4.0 registryd/` (or
`go build -ldflags "-X registryd/internal/version.Version=1.4.0"`).

---

## B. ARCHITECTURE notes

### Audit log

- **Table `audit_log`** (`web/src/db/audit-schema.ts`): `id bigserial`,
  `created_at`, `actor_type` (`user | sa | system | api-token`), `actor_id`,
  `actor_label` (email snapshot), `impersonator_id`, `action` (dotted:
  `org.create`, `repo.visibility`, `auth.sign_in.failed`, …),
  `organization_id` (plain text, no FK — history outlives the org),
  `target_type`, `target_id`, `target_label`, `details jsonb`, `ip`,
  `user_agent`. Indexes on `created_at`, `(organization_id, created_at)`,
  `(actor_id, created_at)`. registryd never touches it.
- **Writer** `lib/audit.ts` → `recordAudit({ action, … })`. Fills the actor
  from the current better-auth endpoint context (inside auth hooks) or from
  the request headers / session (server actions, route handlers), the IP from
  `x-forwarded-for` / `x-real-ip`, and the user agent. Details go through
  `redactDetails` (drops anything that looks like a credential, caps size).
  Never throws; failures are logged. Pruning: once an hour after an insert,
  `DELETE … WHERE created_at < now() - AUDIT_RETENTION_DAYS`.
- **Instrumentation**: one `await recordAudit(...)` per mutation in
  `app/actions/*` (repositories, tags, credentials, webhooks, mirrors, pull
  policies, org/user settings, limits, admin org management, instance
  settings, jobs) and in `lib/auth-audit.ts` for better-auth:
  `hooks.before` (sign-out, reset-password token → user), `hooks.after`
  (failed sign-ins on every sign-in / 2FA / passkey route, admin routes
  `set-role`, `ban-user`, `unban-user`, `impersonate-user`,
  `stop-impersonating`, …, password change / reset, passkey add / remove,
  session revocation, account link / unlink), `databaseHooks`
  (`user.create.after` → `auth.sign_up` for every provider,
  `session.create.after` → `auth.sign_in` with the method,
  `user.update.before` → `auth.2fa.enable` / `disable`), and
  `organizationHooks.after*` (create / update / delete, members, roles,
  invitations). CSV exports are logged as `audit.export`.
- **Reads** `lib/audit-query.ts` (`queryAudit`, `exportAudit`), pure helpers
  in `lib/audit-shared.ts` (filter parsing from search params, CSV with
  formula-injection guarding, action groups). Pages `app/(app)/admin/audit`
  and `app/(app)/[org]/(org)/audit`, route `app/api/admin/audit.csv`
  (admins: everything; org owners/admins: their org via `?org=`).

### Sign-up controls

- Settings section `access` in `instance_settings`
  (`lib/instance-settings.ts`; env defaults `SIGNUP_MODE`,
  `SIGNUP_ALLOWED_DOMAINS`, `ORG_CREATION`; pure types in
  `lib/access-shared.ts`).
- Enforcement in `lib/signup-policy.ts`, called from better-auth's
  `databaseHooks.user.create.before` (`lib/auth.ts`) — the single choke
  point for email sign-up, magic link / email OTP sign-ups, OAuth / OIDC first
  login (`createOAuthUser`) and LDAP provisioning (`provisionLdapUser`,
  browser and token endpoint). It throws an `APIError` with a user-facing
  message. Order: domain list (always) → sign-up mode (skipped for the first
  account). Invite mode accepts a pending, unexpired invitation whose email
  matches; the sign-up form sends the invitation id in the
  `x-chicoree-invitation` header so the check is exact, otherwise any
  pending invitation for the address counts (so social logins work for
  invitees too). The auth instance is rebuilt on settings save (`getAuth()`),
  so the hook always sees the current policy.
- Organization creation: `organizationHooks.beforeCreateOrganization` throws
  for non-admins when the policy is `admins`; `/orgs/new`, the dashboard
  button and the sidebar "+" hide accordingly (`canCreateOrganization`).
- UI: `/sign-up` is a server page that decides between the form (with the
  invitation prefilled and locked) and an explanation; `/sign-in` takes
  `?invitation=` and `?next=` (same-origin paths only) so the invitation flow
  returns to `/accept-invitation/<id>`, which now renders server-side with
  sign-in / create-account links for signed-out visitors.

### Branding

- Settings section `branding` (env defaults `INSTANCE_NAME`,
  `INSTANCE_TAGLINE`; pure types, validation and the banner hash in
  `lib/branding-shared.ts`). Logo validation: PNG magic bytes or an SVG with
  no `<script>`, event handlers, `foreignObject`, or external references;
  ≤ 64 KB; stored as a data URL inside the JSON.
- `lib/branding.ts#getBranding` reads `headers()` before touching the
  database so the root layout stays buildable, and falls back to defaults on
  any error. The root layout's `generateMetadata` uses it for titles; the
  `<body>` gets `--brand` from the accent colour. `components/brand.tsx`
  (`BrandMark`, `BrandLockup`) swaps the blossom for the logo; the sidebar,
  mobile header, auth layout and landing page take it as props. Emails get
  the instance name through `mailLayout(title, body, brand)` and the subject
  lines in `lib/auth.ts`.
- Announcement: `components/shell/announcement-bar.tsx`, rendered in the app
  shell (content column) and the auth layout; dismissal stored in
  `localStorage["chicoree.announcement.dismissed"]` = FNV-1a hash of
  level + text; `danger` is never dismissible.

### Health

- `lib/health.ts`: `runHealthChecks()` (admin page) and `quickHealth()`
  (`/api/health`). Every check is wrapped by a 3-second timeout and a
  catch-all that turns exceptions into a red card.
- registryd gained `GET /internal/v1/status` (bearer = `WEBHOOK_SECRET`,
  like `/internal/v1/gc`): `version` (from `internal/version.Version`, set
  through `-ldflags -X …`; the Dockerfile passes `ARG VERSION`), Go version,
  storage driver, staging dir and its free bytes (`statfs`, unix only),
  blob count and physical bytes (`store.BlobStats`), start time / uptime,
  `publicKeyFingerprint` (hex SHA-256 of the PKIX DER of the trusted key) and
  `authDisabled`. The web app derives the same fingerprint from
  `JWT_PRIVATE_KEY_FILE` with node's `crypto` and compares.
- Clair: `/healthz` is served on Clair's introspection port, so on the API
  port the probe falls back to `GET /indexer/api/v1/index_state`; updater
  freshness comes from `GET /matcher/api/v1/internal/update_operation`
  (Clair 4.8: `{ "<updater>": [ { ref, updater, fingerprint, date } ] }`),
  reported as the newest `date` across updaters (warn after 48 h or when no
  updater has run).
- Postgres: `pg_database_size`, `pg_stat_activity` vs `max_connections`,
  and `drizzle.__drizzle_migrations` row count when that table exists.

### Environment variables added

`SIGNUP_MODE`, `SIGNUP_ALLOWED_DOMAINS`, `ORG_CREATION`, `INSTANCE_NAME`,
`INSTANCE_TAGLINE`, `AUDIT_RETENTION_DAYS` (web). `docker-compose.yml` passes
them through; `registryd/Dockerfile` accepts `--build-arg VERSION`.
