# Automation: job scheduler, notifications, organization webhooks

Work-in-progress notes for the `automation` feature set. Part (a) is
README-ready user documentation, part (b) holds the ARCHITECTURE notes.

---

## (a) README sections

### Scheduling jobs

Every maintenance job on *Administration → Jobs* has a **Schedule** block
next to its *Run now* form: switch the schedule on, pick *Every hour*,
*Daily at 03:00*, *Weekly, Sunday 04:00* or type any 5-field cron
expression (`minute hour day-of-month month day-of-week`), choose the time
zone the expression is read in (IANA name, default `UTC`) and set the
parameters scheduled runs should use. The form shows what the expression
means in plain English and the next three run times; invalid expressions
are rejected before and after submitting. The *Recent runs* table shows how
each run was started (manual, API or schedule), and each job card shows the
outcome of its last scheduled run.

Schedules are checked every 30 seconds. With several web replicas exactly
one of them runs the jobs that are due (a Postgres advisory lock decides),
a job never runs twice at the same time (a due schedule waits until the
running instance has finished), and a run that is still marked *running*
after six hours is closed as failed so the job can run again.

Installs that trigger jobs from external cron through the jobs API can set
`JOB_SCHEDULER=false`; schedules are then stored but never executed by the
app, and the Jobs page says so.

### Notifications

Chicorée emails the people responsible when something needs attention:

| Event | Who | Sent when |
| --- | --- | --- |
| `scan.blocked` | organization owners and admins | a scan pushes an image over the pull policy threshold (`docker pull` now answers 403) |
| `scan.completed` | organization owners and admins | every finished scan, with its severity summary — **off by default** |
| `mirror.failed` | organization owners and admins | a mirror sync fails |
| `webhook.failed` | organization owners and admins | a webhook delivery fails after its final retry |
| `quota.warning` | organization owners and admins | storage or repository usage reaches 80 % / 95 % of a limit — once per threshold, organization and 24 hours |
| `job.failed` | instance administrators | any job run fails (manual, API or scheduled) |

Every user chooses under *Settings → Notifications* which of these arrive
by email; everything is on except `scan.completed`. Emails use the SMTP
settings from *Administration → Email* and link straight to the image,
mirror, delivery log, organization or jobs page concerned. Organization
webhooks can subscribe to the same events (next section).

### Webhooks

Webhooks exist at two levels:

- **Repository webhooks** (*Repository → Settings → Webhooks*, up to five)
  fire for events in that repository.
- **Organization webhooks** (*Organization → Settings → Webhooks*, up to
  ten) fire for events in every repository of the organization, plus the
  organization-level `quota.warning`.

Both share the same form (HTTP method, extra headers, bearer/basic/custom
header authentication with secrets encrypted at rest, an optional signing
secret for `X-Chicoree-Signature: sha256=<hmac>`), the same delivery log
(last 50 attempts per hook), retries on network errors and 5xx answers, and
*Send test*. Each hook picks the events it wants:

| Event | Fires when | Extra payload fields |
| --- | --- | --- |
| `push` | an image or tag is pushed | `tag`, `image` (digest, media type, layers, platform, config, url), `actor` — unchanged from before |
| `delete` | a tag or manifest is deleted (UI, `skopeo delete`, `DELETE /v2/...`) | `tag` (null for digest deletes), `tags` (every tag that pointed at the manifest), `digest`, `image`, `actor` |
| `scan.completed` | a vulnerability scan finished | `tag`, `tags`, `image`, `scan { status, summary, blocked, reason }` |
| `scan.blocked` | a scan put the image over the pull policy | `tag`, `tags`, `image`, `reason` |
| `mirror.completed` | a mirror sync finished | `mirror { id, source }`, `run { id, status, matched, imported, skipped, failed, error }` |
| `mirror.failed` | a mirror sync failed | `mirror { id, source }`, `run { id, status: "failed", error }` |
| `retention.completed` | a retention run deleted (or, dry run, would delete) tags | `dryRun`, `deletedTags`, `deletedDigests`, `keptTags?`, `policy?`, `actor?` |
| `quota.warning` | usage reached 80 % / 95 % of a limit (organization hooks only) | `organization { slug, name }`, `quota { kind, used, limit, percent, threshold }`; `repository` is `null` |

Every delivery carries the same envelope:

```json
{
  "event": "delete",
  "deliveryId": "2e4cf502-…",
  "timestamp": "2026-09-03T19:45:14.813Z",
  "registry": "cr.example.com",
  "repository": {
    "id": "…", "name": "alpine", "path": "acme/alpine",
    "organization": { "slug": "acme", "name": "Acme" },
    "visibility": "private", "url": "https://registry.example.com/acme/alpine"
  },
  "tag": "v1", "tags": ["v1"], "digest": "sha256:45e0…",
  "actor": { "type": "user", "id": "…", "name": "Admin" }
}
```

plus the headers `X-Chicoree-Event`, `X-Chicoree-Delivery` and, when a
signing secret is set, `X-Chicoree-Signature`. The `push` body is exactly
what earlier versions sent; the other events add their fields next to the
envelope.

---

## (b) ARCHITECTURE notes

### Job scheduler

- **Table `job_schedules`** (one row per job name): `job` PK, `cron`
  (5-field), `params` jsonb (same keys as the manual form; blanks fall back
  to the job's defaults at run time), `enabled`, `timezone` (IANA, default
  `UTC`), `last_run_at`, `next_run_at`, `last_status`
  (`succeeded` | `failed` | `skipped: already running` | `skipped: unknown job`
  | `disabled: invalid cron`), `updated_by`, `updated_at`.
- **`lib/schedule-shared.ts`** (browser-safe): presets, `validateCron`,
  `validateTimezone`, `nextRuns`/`nextRun`, `describeCron` (plain-English
  reading), `formatRunTime`. Built on the `cron-parser` package (v5; pulls in
  `luxon` for time zones). The admin form imports it for the live preview,
  the server for validation and `next_run_at`.
- **`lib/schedules.ts`**: `listSchedules`, `saveSchedule` (validates job,
  zone and expression; stores only documented params; computes
  `next_run_at` when enabled), `lastScheduledRun`, `toScheduleView`.
- **`lib/scheduler.ts`** — started from `src/instrumentation.ts`
  (`register()`, Node runtime only, skipped while `NEXT_PHASE` is the
  production build; a `globalThis` singleton survives dev reloads). Every
  30 s a tick:
  1. holds a dedicated `pg.Client` and calls
     `pg_try_advisory_lock(7261637)` — a session-level lock, so the replica
     that gets it keeps it while the connection lives; the others log
     "standing by" once and retry each tick. `SELECT 1` on the lock
     connection each tick detects a dead connection, which is rebuilt (and
     the lock re-acquired by whoever gets there first).
  2. `UPDATE job_runs … status='failed'` for rows still `running` after
     6 hours (each one also raises `job.failed`).
  3. selects enabled schedules with `next_run_at <= now()` (or NULL: those
     only get their first slot computed), skips a job that has a `running`
     `job_runs` row (`last_status = 'skipped: already running'`, `next_run_at`
     left in the past so it starts right after), otherwise sets
     `last_run_at`/`next_run_at`, calls `runJob(name, params, "schedule")`
     and stores `last_status`.
  Every step is wrapped; errors are logged and the interval keeps running.
  `schedulerStatus()` feeds the status line on `/admin/jobs` (enabled,
  holds the lock, last tick, last error).
- **Env**: `JOB_SCHEDULER=false` disables the loop (documented in
  `.env.example`); `env.jobSchedulerEnabled`.
- **UI**: `app/(app)/admin/jobs/job-card.tsx` (`ScheduleForm`),
  `app/actions/schedules.ts` (`saveScheduleAction`, admin only). Jobs are
  read from the `JOBS` registry, so a job added to `lib/jobs.ts` gets a
  schedule block without further code. The runs table has a *Trigger*
  column (`user:<id>` → manual, `api-token` → API, `schedule`).
- **Tests**: a throwaway `npx tsx` script exercised `describeCron`,
  `validateCron`, `nextRuns` (see the verification log in the report).

### Notification framework

- **`lib/notify-shared.ts`** (browser-safe): the `NotificationEvent` union,
  `NOTIFICATION_EVENTS` (label, description, scope, default) —
  the Settings tab renders from it, `notify` reads defaults from it.
- **`lib/notify.ts`**: `notify(input)` with a discriminated-union input per
  event. Resolves recipients (`member` rows with role owner/admin joined to
  non-banned users; or `user.role = 'admin'`), drops those who switched the
  event off (`notification_preferences`, defaults from notify-shared),
  renders subject/text/html (`mailLayout` gained an optional footer
  argument so notifications explain why the reader gets them), sends one
  mail per recipient through `sendMail` (logged when SMTP is not
  configured), and forwards organization-scoped events to webhooks through
  `emitRepositoryEvent` / `emitOrganizationEvent`. `webhook.failed` and
  `job.failed` never fan out to webhooks (no loops; instance-level).
- **Hooks into existing code** (all additive):
  - `lib/jobs.ts` `runJob` catch → `job.failed`.
  - `lib/scheduler.ts` stuck-run sweep → `job.failed`.
  - `lib/scan.ts` after a stored scan and block refresh → `scan.completed`
    (with the block reason from `manifestBlockReason`).
  - `lib/pull-policy.ts` `refreshRepositoryBlocks` collects digests that
    were not blocked before → one `scan.blocked` per refresh (email lists
    every newly blocked image; one webhook delivery per image).
  - `lib/mirror.ts` `runMirror` → `mirror.failed` (both the exception path
    and "nothing imported, everything failed") or the `mirror.completed`
    webhook.
  - `lib/webhooks.ts` `deliverWebhook` → `webhook.failed` after the last
    attempt (dynamic import of notify to avoid a module cycle).
  - `checkQuotaWarnings(organizationId)` compares `getOrgUsage` with
    `getOrgLimits` for storage / public / private repositories; the highest
    crossed threshold (95 before 80) is sent once per
    `quota.warning:<org>:<kind>:<threshold>` key per 24 h — an
    `INSERT … ON CONFLICT DO UPDATE … WHERE sent_at < now() - 24h RETURNING`
    on **`notification_state`** makes the dedupe atomic across replicas.
    Called after every `manifest.push` event from registryd
    (`api/internal/events/route.ts`), after `createRepository` /
    visibility changes (`app/actions/repositories.ts`) and after an admin
    saves organization limits (`app/actions/limits.ts`). Owner-level
    account limits are not evaluated here (they span organizations).
- **Tables**: `notification_preferences` (`user_id`, `event`, `email`,
  `updated_at`; PK user+event; rows only for events the user saved),
  `notification_state` (`key` PK, `sent_at`).
- **UI**: `app/(app)/settings/notifications/` (tab in `settings-nav.tsx`;
  `job.failed` only shown to admins), `app/actions/notifications.ts`.

### Webhooks (organization scope, more events)

- **Schema**: `repository_webhooks.repository_id` is now nullable and the
  table gained `organization_id` (nullable, FK organization, cascade) plus
  index `repository_webhooks_org_idx`. A row with `organization_id` set and
  `repository_id` NULL is an organization hook. `webhook_deliveries` is
  unchanged and shared. Limits: 5 per repository, 10 per organization
  (`lib/webhooks-shared.ts`).
- **`lib/webhooks-shared.ts`** (browser-safe): `WEBHOOK_EVENTS` catalogue
  (`quota.warning` is `organizationOnly`), `eventsForScope`, `WebhookRow`,
  `WebhookScope`.
- **`lib/webhooks.ts`**: `WebhookEnvelope` (event, deliveryId, timestamp,
  registry, repository | null); `WebhookPayload` (push) extends it
  unchanged. `hooksForRepository(repoId, orgId)` = the repository's hooks +
  the organization's; `dispatchRepositoryWebhooks` filters by subscription
  (`test` counts as `push`); `dispatchOrganizationWebhooks` for
  organization-level events; **`emitRepositoryEvent(repositoryId, event,
  data)`** builds the envelope and delivers — this is the helper other
  features call (`retention.completed` with a `RetentionCompletedPayload`:
  `{ dryRun, deletedTags, deletedDigests, keptTags?, policy?, actor? }`);
  `emitOrganizationEvent(orgId, "quota.warning", data)`;
  `listWebhookRows(scope)`, `countWebhooks`, `findScopedWebhook`,
  `maxWebhooks` back the settings pages and actions.
- **Delete events**: `registryd` now posts `manifest.delete` for tag
  deletes too (with the digest the tag pointed at, resolved before the
  delete) and includes `tags` (every tag that pointed at a manifest
  deleted by digest — `store.TagsForManifest`). `hooks.Event` gained
  `Tags []string`. The web app turns both into a `delete` webhook event.
- **Token endpoint**: `repository:<name>:*` scopes (what `skopeo delete`
  requests) now resolve to every action the caller may have; previously
  `*` was dropped and the delete was denied.
- **UI**: the manager moved to `components/webhooks-manager.tsx` and takes a
  `scope` (`{ kind: "repository", repositoryId }` or
  `{ kind: "organization", organizationId }`) plus the event checklist;
  `app/(app)/[org]/(org)/settings/webhooks/page.tsx` is the new
  organization tab; the repository page reuses it. `app/actions/webhooks.ts`
  resolves the scope from `repositoryId` / `organizationId` in the form and
  requires owner/admin of the organization either way. *Send test* on an
  organization hook uses the most recently pushed tag of any repository in
  the organization (a stub with `repository: null` when there is none).

### Migration notes (drizzle-kit generate after merge)

Expected DDL — no data moves:

```sql
ALTER TABLE repository_webhooks ALTER COLUMN repository_id DROP NOT NULL;
ALTER TABLE repository_webhooks ADD COLUMN organization_id text REFERENCES organization(id) ON DELETE CASCADE;
CREATE INDEX repository_webhooks_org_idx ON repository_webhooks (organization_id);
CREATE TABLE job_schedules (…);           -- see registry-schema.ts
CREATE TABLE notification_preferences (…);
CREATE TABLE notification_state (…);
```

Existing repository hooks keep working unchanged (`repository_id` set,
`organization_id` NULL, `events = ["push"]`).

### Dependencies

- `cron-parser` ^5.10.0 (web) — current major; brings `luxon` ^3.7.
