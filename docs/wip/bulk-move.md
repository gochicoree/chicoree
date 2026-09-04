# Bulk repository move (`bulk-move`)

Moving many repositories into one organization in a single run, and the
refactor that made the single-repository transfer and the bulk run share one
copy of the rules.

---

## Part A — README-ready sections

### Moving many repositories at once

After importing repositories from another registry they usually all land in one
place. Sorting eighteen of them by opening eighteen danger zones is tedious, so
instance administrators get a screen that does the whole batch:
**Administration → Organizations → Move repositories…**
(`/admin/organizations/move`).

The screen works in four steps.

1. **Target organization.** Where everything ends up. Instance administrators
   may move any repository on the instance, whether or not they are a member of
   the source or the target. Choosing a proxy cache is allowed but flagged
   immediately — a proxy cache is filled only by its upstream, so every
   repository would be skipped.

2. **Repositories.** Every repository on the instance, with its organization,
   name, visibility, tag count and size. Filter by organization, by name, or
   both; **Select all shown** ticks everything the current filter leaves
   visible, so "select all in this organization" is one click after picking the
   organization from the filter. Repositories that already live in the target
   are shown greyed out and cannot be selected.

3. **Preview.** Nothing is written. For every selected repository the preview
   says either *will move* or why it will be skipped:

   | Reason | What happened |
   | --- | --- |
   | `name taken` | The target already has a repository with that name — rename one of them first. |
   | `proxy source` | The repository lives in a proxy cache; those mirror upstream names and never move. |
   | `proxy target` | The target is a proxy cache; only its upstream fills it. |
   | `repository quota` | The target (or its owner's account) has reached its public/private repository limit. |
   | `storage quota` | The blobs that are new to the target would push it over its storage limit. |
   | `invalid name` | The name is not a valid repository name in the target. |
   | `already there` | The repository is already in the target organization. |

   The preview also shows the **total bytes that are new to the target** —
   layers the target already stores cost nothing, so moving two repositories
   that share a base image is cheaper than the sum of their sizes — and the
   resulting storage, public-repository and private-repository usage against
   the target's limits.

4. **Confirmation and run.** The confirmation spells out the consequences
   before anything is written:

   - The new reference is `<registry>/<target>/<name>`.
   - Each old `org/name` keeps working for **pulls** and tag lists through a
     redirect; a **push** or a delete against the old name is refused, with an
     error naming the new location.
   - Organization-scoped policies of the source no longer apply — pull
     policies, organization-wide tag rules and retention settings are the
     target's now. Rules attached to a *repository* move with it.
   - Members of the source organization lose access unless they are members of
     the target.
   - Tags, scans, webhooks, mirrors and stars are untouched. CI pipelines that
     push to the old names must be updated.

   The run then moves the repositories one at a time and continues past
   failures. The result table lists what moved (with a link to its new home)
   and what did not, with the reason.

A single run moves at most **50 repositories**. The moves are deliberately
sequential — each one commits before the next is checked — so the target's
quotas always see what has actually landed rather than an estimate. Selecting
more than 50 shows a message asking for smaller batches.

Every move is audited exactly like a single transfer: one `repo.transfer` entry
in the source organization and one in the target. The run itself adds a single
`repo.bulk_transfer` summary entry in the target.

### Moving one repository

Unchanged: **Repository → Settings → Danger zone → Move to another
organization**. Organization owners and admins may move a repository between
two organizations they both manage; instance administrators may move any of
them. It now enforces exactly the same rules as the bulk screen, because both
call the same function.

---

## Part B — ARCHITECTURE-ready notes

### `web/src/lib/repo-move.ts` — one copy of the rules

The transfer logic used to live inside the `transferRepository` server action.
It now lives in `lib/repo-move.ts` and is split in two halves so a caller can
show a preview:

```ts
planRepositoryMove({ repositoryId, targetOrganizationId, actor, batch? })
  → MovePlan            // every check, no writes at all

moveRepositoryToOrganization({ repositoryId, targetOrganizationId, actor })
  → MoveResult          // re-plans, then performs
```

`MovePlan` carries `ok`, a machine-readable `code` (`MoveSkipCode`), the
human-readable `message`, the source and target organizations and `bytesNew`
(the blobs the target does not hold yet). `MoveResult` extends it with `moved`,
`href` and `pullReference`. Because `moveRepositoryToOrganization` re-runs the
plan itself, a stale preview can never let a move through.

Checks, in order (the messages are the ones the danger zone has always shown):

1. the repository exists;
2. the actor manages the **source** (instance admins manage everything);
3. both organizations exist, and they differ;
4. the actor manages the **target**;
5. neither side is a proxy cache;
6. the name is valid as a non-nested repository name;
7. the name is free in the target;
8. the target's repository quota (`checkRepoQuota`) allows one more of that
   visibility;
9. the target's storage quota (`checkStorageQuota`) allows `bytesNew` more.

The move itself, unchanged in behaviour, in one transaction: re-home
`repositories`, re-home the repository-scoped `tag_rules` and
`retention_policies` rows (their `organization_id` column must follow the row),
clear any redirect that pointed the name inside the target, then insert a
`repository_redirects` row for the old `source-slug/name`. After the
transaction: two `repo.transfer` audit entries (source and target), then in
`after()` a `refreshRepositoryBlocks` (the pull policy is the target's now), a
`checkQuotaWarnings` and the `repository.transferred` webhook. Four
`revalidatePath` calls cover both organization pages and both repository pages.

`app/actions/repo-tools.ts#transferRepository` is now a nine-line wrapper: read
the two form fields, `requireSession`, call the function, map `message` onto
`RepoToolResult.error`. Its public signature, its form fields and its UI are
untouched.

### Batch accounting

Sequential execution makes the *run* correct for free: repository *i+1* is
checked after *i* is committed, so `getOrgUsage` and `bytesNewToOrg` already see
it. Only the **preview** has to simulate, which is what `BatchContext` is for:

```ts
interface BatchContext {
  repositoryIds: string[];   // already planned into the target
  names: Set<string>;        // names already claimed in the target
  pendingPublic: number;
  pendingPrivate: number;
  pendingBytes: number;
}
```

`planBulkMove(ids, targetId, actor)` walks the ids in order, folding each
accepted plan into the context with `applyToBatch`. Consequently the preview
catches a name collision *between two selected repositories*, counts a layer
shared by two moved repositories once, and reports the quota skip at the same
repository the real run will skip at.

`bytesNewToOrg(repositoryId, organizationId, exclude[])` gained the `exclude`
argument for this: blobs already covered by an earlier repository in the batch
do not count again. It is parameterised with
`ANY(string_to_array($n, ','))`, the same shape `lib/shared-layers.ts` uses.

`checkRepoQuota` in `lib/quota.ts` gained a fourth optional argument,
`pending = 0`, added to the current usage before comparing against the limit.
Every existing caller is unaffected (it defaults to 0).

### `web/src/lib/repo-move-shared.ts`

Pure module, safe for client components (`lib/repo-move.ts` itself imports
`@/db`). Holds `MAX_BULK_MOVE = 50`, the `MoveSkipCode` union and `skipLabel()`,
which turns a code into the short badge text. `lib/repo-move.ts` re-exports both
so server code has a single import.

### `web/src/app/actions/bulk-move.ts`

Two server actions, both `requireAdmin()`, both taking `FormData`
(`targetOrganizationId`, repeated `repositoryIds`) like the rest of the app:

- `previewBulkMove(formData) → BulkMovePreview` — validates the input (target
  chosen, at least one repository, at most `MAX_BULK_MOVE`), runs
  `planBulkMove`, and adds the target's current `Usage`/`Limits` plus the
  resulting usage. Reads only.
- `runBulkMove(formData) → BulkMoveRun` — the same validation, then
  `moveRepositoryToOrganization` per id in a `for` loop with a `try/catch` so a
  thrown error becomes a `failed` row and the loop continues. Finishes with one
  `repo.bulk_transfer` audit entry on the target summarising the run.

Ids are de-duplicated while keeping the order the administrator picked them in,
which is the order the run follows.

### UI

- `app/(app)/admin/organizations/move/page.tsx` — server component:
  `requireAdmin`, then `listAdminOrganizations()`, `listAllRepositories()` and
  the set of proxy-cache organization ids. `export const dynamic =
  "force-dynamic"` (it reads the database on every request).
- `app/(app)/admin/organizations/move/bulk-move-form.tsx` — the `"use client"`
  wizard. It imports the two server actions and, for pure helpers, only
  `lib/repo-move-shared.ts` and `lib/format.ts`; it never reaches `@/db`.
  Selection is a `string[]` (order matters), membership tests go through a
  memoised `Set`. Picking a new target drops any selected repository that is
  already in it; changing the selection clears a stale preview.
- `listAllRepositories()` lives in `lib/repo-move.ts` and returns id, name,
  organization, slug, visibility, size, tag count and a proxy flag for every
  repository on the instance.
- `/admin/organizations` gained one link in its card header
  (`Move repositories…`). **No admin nav entry was added**: `AdminNav` is a flat
  list of top-level sections and `/admin/organizations/move` is a sub-page of
  one of them. Because the `Organizations` tab is not `exact`, `NavTabs`
  already highlights it on the move screen.

### Schema

**No schema change.** The feature reuses `repositories`, `repository_redirects`,
`tag_rules`, `retention_policies`, `organization_proxies`,
`organization_limits`, `user_limits`, `blobs`/`repository_blobs` and
`audit_log`. No custom migration SQL is needed. Nothing in `registryd/` was
touched — the Go side already serves moved repositories through
`repository_redirects` (`internal/api/redirects.go`) and already refuses pushes
to a redirected name.

### New audit action

| Action | Organization | Target | Details |
| --- | --- | --- | --- |
| `repo.bulk_transfer` | the target | the target organization | `requested`, `moved`, `skipped`, `bytesAdded`, `repositories[]` (`from → to` strings) |

It sits under the existing `repo` group in `AUDIT_ACTION_GROUPS`, so the audit
filters pick it up with no change. The per-repository `repo.transfer` entries
are written by `moveRepositoryToOrganization` exactly as before.

### Env vars, endpoints, jobs

None added.
