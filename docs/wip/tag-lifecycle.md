# Tag lifecycle: immutable / protected tags, retention, untagged manifests

Work-in-progress notes for the `tag-lifecycle` feature set. Section (a) is
README-ready user documentation, section (b) holds the ARCHITECTURE notes.

## (a) README sections

### Tag rules: immutable and protected tags

*Organization → Settings → Policies* and *Repository → Settings → Policies*
both have a **Tag rules** card. A rule is a glob over tag names (`*` matches
anything, `?` one character, everything else is literal; `v*`, `release-*`,
`latest`) with two switches:

- **Immutable** — once the tag exists it cannot be re-pointed at a different
  image. Pushing the *same* image again is fine; pushing anything else is
  refused by the registry with `403 DENIED`:

  ```
  denied: tag v1 is immutable (rule "v*"): it already points at sha256:45e09956dc66 and cannot be re-pointed
  ```

- **Protected** — the tag cannot be deleted, and neither can the image it
  names (deleting by digest would take the tag with it). `docker`/`skopeo`
  deletes and the trash button in the UI are both refused:

  ```
  denied: tag latest is protected (rule "latest") and cannot be deleted
  denied: manifest sha256:45e09956dc66 is tagged latest, which is protected (rule "latest"); the tag must be unprotected first
  ```

Organization rules apply to every repository; repository rules add to them
and are shown on the repository page as read-only "inherited" rows. Tags
covered by a rule carry a small *immutable* / *protected* badge in the tag
list and on the tag page. Mirror imports go through the registry like any
push, so an immutable tag stops a mirror from re-pointing it (the mirror run
records the refusal per tag). Organization owners and admins (and instance
administrators) manage rules; at most 50 per scope.

### Retention policies

The **Retention** card (same two pages) removes old tags and leftover images
automatically. An organization policy is the default for all its
repositories; a repository can *inherit* it or set a *custom* policy that
replaces it entirely. Fields:

| Field | Meaning |
| --- | --- |
| Keep the newest tags | The N most recently pushed tags always stay. |
| Always keep tags matching | Space-separated globs of tags that always stay, e.g. `latest v*`. |
| Delete tags older than (days) | Tags whose last push is older than N days are candidates. |
| Delete untagged manifests after (days) | Images no tag points at, pushed more than N days ago, are deleted. |

How the pieces combine: a tag is deleted when it is older than the *delete
tags older than* threshold (or, when only a keep count is set, whenever it
is outside the newest N) **and** nothing keeps it — a protected tag rule, a
*keep matching* pattern, or being among the newest N. `latest` gets no
special treatment: list it under *keep matching* if it must survive.
Deleting a tag never deletes the image itself; the manifest becomes untagged
and the untagged rule (or *prune-untagged*) picks it up later. Untagged
platform variants of a multi-arch index that still exists, artifacts attached
to another image (referrers) and images with referrers are never removed by
the untagged rule. Layer data is reclaimed by the next garbage collection.

- **Preview** plans the values currently in the form (unsaved is fine)
  against the repository — or every repository of the organization; those
  with their own policy keep it — and lists what would go and why, plus what
  stays and why. Nothing is deleted.
- **Run now** applies the *saved* policy for that scope immediately after a
  confirmation; the outcome is shown on the page and recorded as a
  `retention` job run.
- The **retention** job (*Administration → Jobs*, or
  `POST /api/jobs/retention`) walks every repository with an enabled policy.
  It is a dry run unless `dryRun=false`; `organization=<slug>` and
  `repository=<org/name>` narrow it down. Schedule it from cron:

  ```sh
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/retention?dryRun=false"
  ```

  The run's result lists per-repository counts and up to 300 lines of what
  was (or would be) deleted with the reason; the Jobs page shows a summary
  with a *details* view.

### Untagged manifests and deleting by digest

The repository page has an **Untagged manifests** section listing every
image no tag points at: short digest (copyable), media type and platform,
size, when it was pushed, and badges for *index child* (a platform variant
of a multi-arch index in the repository), *referrer* (attached to another
image) and *N attached*. Owners and admins can delete an untagged image by
digest from there; platform variants of an index that still exists are
refused (delete the index instead).

The tag page has a **Delete image** button that removes the manifest by
digest together with *every* tag pointing at it — the confirmation lists
those tags. It is disabled while a protected tag names the image or the
image belongs to an existing index. `docker pull …@sha256:…` answers
`manifest unknown` afterwards; layers stay until garbage collection.

The *Operations → Deleting tags* paragraph should add: protected tags cannot
be deleted, and if `latest` is immutable or protected it stays where it is
instead of following the newest remaining tag.

## (b) ARCHITECTURE notes

### Tables (drizzle, `web/src/db/registry-schema.ts`; read by registryd)

- `tag_rules` (id, organization_id NOT NULL, repository_id NULL = every
  repository of the org, pattern, immutable, protected, created_by,
  created_at). Indexes on organization_id and repository_id. Repository rows
  are evaluated before organization rows; the first matching rule per flag
  wins (only the pattern matters, so order is cosmetic).
- `retention_policies` (id, organization_id NOT NULL, repository_id NULL =
  org default, enabled, keep_last, keep_matching, delete_older_than_days,
  delete_untagged_after_days, updated_by, updated_at) with
  `UNIQUE NULLS NOT DISTINCT (organization_id, repository_id)` — one org
  default plus at most one row per repository (Postgres 15+).

No custom migration SQL is needed; both tables are new and empty.

### registryd enforcement (`internal/store/tagrules.go`, `internal/api/manifests.go`)

- `MatchTagGlob` is the single glob matcher (`*`, `?`, literal otherwise;
  case-sensitive); `web/src/lib/tag-rules-shared.ts` has the identical
  algorithm for the UI and the planner. Table tests in `tagrules_test.go`;
  `TestTagRuleChecks` runs the store checks against a real database when
  `REGISTRYD_TEST_DATABASE_URL` is set (skipped otherwise).
- Manifest **PUT by tag**: `CheckTagImmutable` runs right after the
  repository is resolved (before anything is written); the tag is then
  written with `UpsertTagGuarded`, which takes a `FOR UPDATE` lock on the tag
  row and repeats the check inside the transaction so concurrent pushes
  cannot race past it. Same digest → allowed; new tag → allowed.
- Manifest **DELETE by tag**: `CheckTagDeletable` (protected rule).
  **DELETE by digest**: `CheckManifestDeletable` refuses when any tag that
  points at the digest is protected.
- Violations are `*store.PolicyError`; `writeStoreError` maps them (like
  quota errors) to `403 DENIED` with the message. Pull paths are untouched.
- Because every write goes through these handlers, mirrors (`mirror:<id>`
  subject), the web app's own "move latest" PUT and docker/skopeo clients are
  all covered.

### Web app

- `lib/tag-rules-shared.ts` (browser-safe): `matchTagGlob`,
  `validateTagPattern`, `tagFlags(rules, tag)` → the immutable/protected rule
  covering a tag. `lib/tag-rules.ts`: `listTagRules(org, repo|null)`,
  `effectiveTagRules(org, repo)` (repo rules first), `protectedReason`.
- `lib/tag-admin.ts` `deleteTag` now refuses protected tags before calling
  the registry, surfaces the registry's 403 message, accepts
  `{ moveLatest: false }` (used by retention so a policy never re-points
  `latest`), and leaves an immutable/protected `latest` alone.
- `lib/manifests.ts`: `listUntaggedManifests(repoId)` (one query with
  subselects: content bytes, index-child, referrer, referrer count, platform
  from the cached config), `tagsForDigest`, `indexParents`,
  `manifestDeleteBlocker` and `deleteManifestByDigest(repoId, digest,
  subject)` which deletes through registryd with a delete-scoped token.
- `lib/retention-shared.ts` (browser-safe): `planRetention({ tags, untagged,
  policy, rules, now })` — the pure planner returning tags/manifests to
  delete and kept entries with reasons; `describeRetention`,
  `parseKeepMatching`, `parseDaysField`. Tag age is the tag's last push
  (`tags.updated_at`, what the repository page shows as *Pushed*); manifest
  age is `manifests.created_at`.
- `lib/retention.ts`: `getRetentionPolicies`, `pickEffective` (repository
  row wins even when disabled), `planRepository`, `planScope` (previews, with
  an unsaved override for the scope's own policy) and `runRetention({ dryRun,
  organizationSlug?, repositoryPath?, subject })` which applies plans through
  `deleteTag` / `deleteManifestByDigest` and builds the run result (counts,
  per-repository summary, detail lines capped at 300 + `truncated`).
- Job `retention` in `lib/jobs.ts` (params `dryRun` default `true`,
  `organization`, `repository`) calls `runRetention` as `user:system`. *Run
  now* on the settings pages goes through `runJob` too (recorded in
  `job_runs`, triggered by the user). `app/(app)/admin/jobs/run-result.tsx`
  renders results carrying a `detail` array as a one-line summary plus a
  modal with the grouped lines.
- Server actions: `app/actions/tag-rules.ts` (`addTagRule` merges flags for
  a duplicate pattern, `removeTagRule`), `app/actions/retention.ts`
  (`saveRetentionPolicy`, `previewRetention`, `runRetentionNow`),
  `app/actions/manifests.ts` (`deleteManifestAction`). All require
  `MANAGER_ROLES` via `getOrgRole` (instance admins act as owners).
- UI: `components/tag-rules-manager.tsx` (list / add / remove; inherited
  org rules read-only on repository pages; exports `RuleBadges`),
  `components/retention-form.tsx` (inherit/custom select on repositories,
  Save / Preview / Run now with confirmation, preview and run panels), the
  Untagged card and `DeleteManifestButton` on the repository page, lock
  badges and *Delete image* on the tag page. The repository settings tab is
  now labelled *Policies* (route unchanged: `/settings/policy`).
- Token endpoint: `repository:<name>:*` (what skopeo/containers-image
  request before a delete) now expands to every valid action, filtered by
  what the caller may do; previously the wildcard was dropped and the token
  carried no grants.
- Activity feed: events by `user:system` (retention runs from the job) show
  the actor as *system* instead of *deleted user*.
