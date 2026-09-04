# Scanning: scanner backends (Clair, Trivy), normalised findings, CVE search and accepted risks

Ready-to-fold sections for `README.md` (part A) and `ARCHITECTURE.md` (part B).

---

## A. README sections

### Vulnerability scanning

Every pushed image is scanned in the background and the result lives next to
the tag (*Vulnerabilities* tab), in the tag list (severity chips), on the
organization's *Security* tab and on *Administration → Security*. Two
scanner backends are supported; pick one under *Administration → Scanning*
or with `SCANNER` in the environment:

| Backend | What runs | When to use it |
| --- | --- | --- |
| **Clair** (default when `CLAIR_URL` is set) | the separate `clair` compose service (v4, combo mode) that fetches layers from the registry itself and matches them against its own database | the established choice; several GB of advisory data in Postgres, updated continuously |
| **Trivy** | the `trivy` binary inside the web container, pulling the image through the registry with a registry token | zero extra services: standalone Trivy downloads a ~100 MB database into the `trivy-cache` volume on the first scan and refreshes it every few hours; optionally a small `trivy` server holds that database once for every web replica |
| **Off** | nothing | vulnerability columns, tabs, the security pages' totals and the `scan-stale` job disappear |

Compose profiles select the services:

```sh
# Clair (default)
COMPOSE_PROFILES=clair   CLAIR_URL=http://clair:6060      # SCANNER may stay empty → clair
# Trivy standalone: no extra service, the web container keeps the database
COMPOSE_PROFILES=        SCANNER=trivy CLAIR_URL=
# Trivy with a shared server (one database for all web replicas)
COMPOSE_PROFILES=trivy   SCANNER=trivy TRIVY_SERVER_URL=http://trivy:4954
# No scanning at all
COMPOSE_PROFILES=        SCANNER=off   CLAIR_URL=
```

The compose files mount the named volume `trivy-cache` at
`/var/lib/chicoree/trivy` in the web container (`TRIVY_CACHE_DIR`) and
`trivy-server-cache` in the optional server. Changing the backend applies to
new scans; stored results keep the label of the scanner that produced them
(shown on the tab and on *Administration → Scanning*).

*Administration → Scanning* has the backend picker (Clair URL, Trivy server
URL and timeout), a **Test** button that probes the entered values without
saving (Clair: liveness and updater freshness; Trivy: binary version,
database age or server health), the last ten scans with their state and
scanner, pending / failed counts, and **Re-scan everything**, which queues
the `scan-stale` job with `olderThan=0s` (500 images per run). *Administration
→ Health* and `/api/metrics` (`chicoree_scanner_up{backend=…}`) report the
same probe.

Environment defaults (the admin page overrides them):

| Variable | Meaning | Default |
| --- | --- | --- |
| `SCANNER` | `off`, `clair` or `trivy` | `clair` when `CLAIR_URL` is set, else `off` |
| `CLAIR_URL` | Clair's API address | empty |
| `TRIVY_SERVER_URL` | optional Trivy server (client/server mode) | empty = standalone |
| `TRIVY_TIMEOUT_SECONDS` | per-image timeout for Trivy | `600` |
| `TRIVY_CACHE_DIR` | where Trivy keeps its database | `/var/lib/chicoree/trivy` in the image |
| `TRIVY_BIN` | the binary to run | `trivy` on `PATH` |

### The Vulnerabilities tab

Findings are shown the same way whichever scanner produced them: severity,
advisory id (linked to the advisory), package and installed version, the
fixed version, and the package type (OS package or library). The toolbar
filters by severity, *fix available* and a free-text search over id,
package and title. Multi-arch tags list their platform variants with each
variant's own report.

### Accepted risks (exceptions)

Organization owners and admins can **accept** a finding from the tab: a
dialog asks for the scope (this repository or the whole organization),
whether the acceptance is limited to the package the finding was reported
in, a justification and an expiry (never, 30 / 90 / 180 / 365 days). Accepted
findings stay in the report, struck through with the justification, and no
longer count against the [pull policy](#pull-policy): an image blocked only
by accepted findings becomes pullable within seconds, and revoking the
exception blocks it again. Exceptions are listed with a *Revoke* button on
the organization's *Security* tab and on *Administration → Security*; every
creation and revocation is in the audit log (`security.exception.create` /
`security.exception.revoke`).

Expired exceptions stop applying as soon as blocks are recomputed (any scan
of the repository, a policy change, or the `exceptions-expire` job — schedule
it hourly under *Administration → Jobs* to apply expiries promptly; it also
deletes exceptions expired for more than 30 days).

### Security pages

- **Organization → Security** (`/<org>/security`, every member): severity
  totals over the organization's tagged images (each multi-arch variant
  counted, identical images once, accepted risks excluded), how many images
  are scanned / waiting / failed, the most affected repositories, the images
  the pull policy currently blocks, and the exceptions.
- **Administration → Security** (`/admin/security`): the same for the whole
  instance plus **Find images by vulnerability**: type a CVE or GHSA id (or a
  package name) and get every tagged image containing it — organization,
  repository, tag, the affected variant, severity, fixed version, whether the
  risk was accepted and whether pulls are blocked.

### Jobs

- `scan-stale` — re-scans tagged images whose last scan is older than
  `olderThan` (default `7d`), never scanned, or failed; `olderThan=0s` means
  everything. Hidden while scanning is off.
- `scan-normalize` — one-off after upgrading: converts scan rows that only
  hold Clair's raw report into normalised findings and fills the search
  table. Rows are also converted lazily the first time their image page is
  opened, so the job is optional.
- `exceptions-expire` — recomputes pull blocks for organizations whose
  exceptions expired and prunes long-expired rows.

---

## B. ARCHITECTURE notes

### Scanner interface

`web/src/lib/scanners/`:

- `types.ts` — the contract: `Scanner { name, label, version(), scan(input),
  health() }`. `ScanInput` carries the repository path, the manifest digest
  and parsed payload, the layer descriptors, `REGISTRY_INTERNAL_URL` and a
  two-hour system pull token for that repository. `scan` returns normalised
  `findings`, the backend's `raw` report, the severity `summary` and the
  scanner version. `health()` returns `{ status: ok|warn|error, summary,
  details[], latencyMs }` for the admin Test button, the health page and the
  Prometheus gauge.
- `clair.ts` — wraps the Clair client (`lib/clair.ts`, every call now takes
  the base URL): submits the layers with `Authorization: Bearer <token>`
  headers, polls `index_report` (5-minute deadline), fetches the
  `vulnerability_report` and normalises it. `normalizeClairReport` walks
  `package_vulnerabilities` → `packages` / `vulnerabilities` /
  `environments` / `distributions`: id = the advisory `name`, severity from
  `normalized_severity`, `fixedIn` from `fixed_in_version`, layer from
  `environments[pkg][0].introduced_in`, type `os` for apk/dpkg/rpm package
  databases and `library` otherwise, ecosystem from the package DB or the
  updater name, distro from `distributions[...].pretty_name`. Health: the
  probe and updater-freshness logic that used to live in `lib/health.ts`.
- `trivy.ts` — runs `trivy image --format json --quiet --scanners vuln
  --image-src remote --timeout <n>s --cache-dir <dir> [--insecure]
  [--server <url>] <registry-host>/<org>/<repo>@<digest>` with
  `execFile` (hard kill at timeout + 30 s, 256 MB output buffer). The pull
  credential is the same two-hour system JWT Clair gets, handed over as a
  docker config entry for the registry host only: a temporary
  `DOCKER_CONFIG` directory (mode 0600, removed after the run) with
  `{"auths":{"<host>":{"registrytoken":"<jwt>"}}}`. go-containerregistry
  uses a `registrytoken` as the Bearer as is, so the token realm is never
  contacted and no extra credential class was needed at the token endpoint;
  scoping it per host matters because Trivy applies a global
  `--registry-token` to every registry, including the ones it downloads its
  database from (`mirror.gcr.io` answered UNAUTHORIZED with the JWT). Nothing
  secret appears on the command line. `--insecure` is added when
  `REGISTRY_INTERNAL_URL` is `http://`. Multi-arch indexes are never
  handed to Trivy: `runScan` skips indexes and each platform child is scanned
  when its own push event arrives, exactly as with Clair.
  `normalizeTrivyReport` maps `Results[].Vulnerabilities[]`
  (`VulnerabilityID`, `PkgName`, `InstalledVersion`, `FixedVersion`,
  `Severity`, `Title`, `Description`, `PrimaryURL` + `References`,
  `Layer.Digest`; `Class` os-pkgs/lang-pkgs → `os`/`library`; `Type` →
  ecosystem; `Metadata.OS` → distro), skipping secret/config/license results
  and exact duplicates. `version()`/`health()` run `trivy version --format
  json` (binary + local database age) and, in client mode, `GET
  <server>/healthz`.
- `normalize.ts` — `reportKind(report)` (Clair vs Trivy shape) and
  `findingsOf(row)`: stored `findings` when present, otherwise the raw
  report normalised on the fly — the lazy path for rows written before the
  column existed.
- `index.ts` — `scannerFromSettings(settings)`, `getScanner()`,
  `scanningEnabled()`, `scannerLabel()`: the single answer to "is scanning
  on?" used by the tag list column, the tab, the jobs list, the health card,
  the metrics gauge and `runScan`.

`lib/scanner-shared.ts` (browser-safe): the `Finding` shape
(`id, severity, package, version, fixedIn, type, title, description, links,
layerDigest, ecosystem, distro`), `Severity`/`SEVERITY_ORDER`,
`ScannerBackend`/`ScannerSettings`, `summarizeFindings`, `sortFindings`,
`normalizeSeverity`, the exception helpers (`exceptionApplies`,
`applyExceptions`, `effectiveSummary`, `isExpired`) and the tab filter
(`filterFindings`).

### Scan orchestration (`lib/scan.ts`)

`runScan(path, digest)` → `getScanner()` (null = off) → status `indexing`
(with the backend name) → `scanner.scan(...)` → `storeScanResult`: the row
gets `status = scanned`, `findings` (jsonb), `summary` (computed from the
findings), `report` (raw), `scanner`, `scanner_version`; `replaceScanFindings`
rewrites the `scan_findings` side rows in a transaction. Then
`refreshRepositoryBlocks`, `manifestBlockReason` and the `scan.completed`
notification (now naming the backend). `ensureFindings(row)` is what the tag
page calls: it returns stored findings or normalises a legacy Clair row and
writes findings, summary, scanner and side rows back. `normalizeLegacyScans`
backs the `scan-normalize` job. `recentScans` / `scanCounts` feed
*Administration → Scanning*.

### Settings

Section `scanner` in `instance_settings` (`lib/instance-settings.ts`):
`{ backend, clairUrl, trivyServerUrl, trivyTimeoutSeconds }`, no secret
fields; env defaults `SCANNER`, `CLAIR_URL`, `TRIVY_SERVER_URL`,
`TRIVY_TIMEOUT_SECONDS` (`env.scanner` derives `clair` from a non-empty
`CLAIR_URL` when `SCANNER` is unset). `TRIVY_BIN` and `TRIVY_CACHE_DIR` are
env-only (`env.trivyBin`, `env.trivyCacheDir`; the latter defaults to
`/var/lib/chicoree/trivy` in production and `.trivy-cache` in development).
`env.clairEnabled` is gone. Actions in `app/actions/scanning.ts`
(`saveScannerSettings`, `testScannerSettings` — builds a scanner from the
unsaved form values and calls `health()` with a 20 s cap —
`resetScannerSettings`, `rescanEverything` — audits `scan.rescan_all` and
runs `scan-stale` with `olderThan=0s, limit=500` in `after()`). Page
`app/(app)/admin/scanning/` (`scanner-form.tsx`, `rescan-button.tsx`), nav
entry *Scanning* in `admin-nav.tsx`.

### Tables and columns

- `vulnerability_scans` gained `findings jsonb`, `scanner text`,
  `scanner_version text`. `summary` keeps its meaning (severity counts,
  now computed from the findings); `report` keeps the raw backend output.
- **`scan_findings`** (`web/src/db/scanning-schema.ts`): `id bigserial`,
  `digest`, `vulnerability_id`, `package`, `version` (default `''`),
  `fixed_in`, `severity`, `type`; indexes on `digest`, `vulnerability_id`,
  `package`. One row per (digest, id, package, version); rewritten by
  `replaceScanFindings` on every stored scan and by the lazy normaliser.
  Backs the CVE search and both security pages.
- **`vulnerability_exceptions`**: `id uuid`, `organization_id` (FK, cascade),
  `repository_id` (FK, cascade; NULL = whole organization),
  `vulnerability_id`, `package` (NULL = any package), `justification`,
  `expires_at` (NULL = never), `created_by`, `created_at`; indexes on
  `organization_id` and `vulnerability_id`.

registryd does not read any of these; `manifest_blocks` stays the contract.

**Migration note**: the three new columns are nullable and the two tables are
new, so `drizzle-kit generate` produces a plain additive migration. Existing
scan rows are converted lazily on read or by running `scan-normalize` once
after the upgrade — no custom SQL is required. (Optional backfill in SQL is
not provided on purpose: the normaliser is TypeScript.)

### Pull policy and exceptions (`lib/pull-policy.ts`)

`loadExceptionRules(orgId, repoId)` returns the organization-wide rules plus
the repository's own; `effectiveScanSummary(scan, rules, repoId)` =
`effectiveSummary(findingsOf(scan), rules)` — the counts after removing
accepted findings (rows with neither findings nor report fall back to their
stored summary). `refreshRepositoryBlocks` judges `violation()` on that
effective summary, so blocks change on exception create / revoke (both call
`refreshRepositoryBlocks` or `refreshOrganizationBlocks`) and on expiry
whenever blocks are recomputed (`exceptions-expire` job). Repository-scoped
rules win over organization-wide ones when both match; ids compare
case-insensitively; a package-limited rule needs an exact package match.

### Security queries (`lib/security.ts`)

All dashboards start from the CTE `tagged` — every tag's manifest digest
plus, through `manifest_refs` joined to `manifests`, the platform children
of index tags — so "tagged images" means single-platform manifests reachable
from a tag, deduplicated by digest. `EXCEPTED` is a reusable `EXISTS` over
`vulnerability_exceptions` (org match, repository NULL or equal,
case-insensitive id, optional package, not expired). `securityTotals`
(per-severity counts of non-excepted findings, accepted count, images by
scan state, blocked count), `worstRepositories` (top 10 by critical / high /
…), `blockedImages` (from `manifest_blocks` with their tags),
`listExceptions` (with the number of findings each currently covers),
`searchFindings(q, orgId|null)` (`vulnerability_id ILIKE %q% OR package
ILIKE %q%`, joined to tags, scans and blocks, 200 rows). `createException`,
`deleteException`, `expireExceptions` recompute blocks as described above.
Actions: `app/actions/security.ts` (`acceptRiskAction`,
`revokeExceptionAction`; managers only via `getOrgRole` + `MANAGER_ROLES`;
audit `security.exception.create` / `.revoke`).

### UI

- `app/(app)/[org]/[repo]/tags/[tag]/vulnerability-panel.tsx` (server:
  notices, summary card with scanner label, accepted count) +
  `findings-table.tsx` (client: severity chips as toggles, *fix available*,
  *hide accepted*, search box, per-finding advisory links, *Accept* button
  for managers opening the exception `Modal`, accepted rows struck through
  with the justification badge). The tag page passes `ensureFindings(scan)`
  and the serialised exception rules; it no longer reads `report`.
- `components/security/security-overview.tsx` (tiles, severity bar, most
  affected, blocked), `exceptions-table.tsx` (client, revoke with
  `ConfirmModal`), `cve-search.tsx` (GET form + results).
  Pages `app/(app)/[org]/(org)/security/page.tsx` (tab *Security* in
  `org-tabs.tsx`, members) and `app/(app)/admin/security/page.tsx` (nav
  *Security*).
- `lib/health.ts`: the Clair card became `scanner` — "Vulnerability scanner
  (Clair|Trivy)" from `scanner.health()`, or *not configured*. `lib/metrics.ts`:
  `chicoree_clair_up` became `chicoree_scanner_up{backend="clair|trivy|off"}`.
- `lib/jobs.ts`: `scan-stale` checks `scanningEnabled()`; new
  `scan-normalize` and `exceptions-expire`; `listJobs()` is now async.

### Image and compose

- `web/Dockerfile`: `COPY --from=aquasec/trivy:0.74.0 /usr/local/bin/trivy
  /usr/local/bin/trivy` (static binary, runs on the alpine node image),
  `TRIVY_CACHE_DIR=/var/lib/chicoree/trivy` created and chowned to `app`.
- `docker-compose.yml` / `docker-compose.prod.yml`: web gets `SCANNER`,
  `TRIVY_SERVER_URL` (empty default = standalone), `TRIVY_CACHE_DIR` and the
  `trivy-cache` volume; optional service `trivy` (`aquasec/trivy:0.74.0`,
  `server --listen 0.0.0.0:4954`, profile `trivy`, volume
  `trivy-server-cache`). `docker-compose.coolify.yml` (no profiles) always
  includes the server and defaults `TRIVY_SERVER_URL` to it.
- `.env.example`: `SCANNER`, `TRIVY_SERVER_URL`, `TRIVY_TIMEOUT_SECONDS` with
  the profile matrix above.
