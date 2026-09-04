# Discovery UX: search, READMEs, stars, recently viewed, onboarding

Branch `w2-discovery`. Two new tables, three new columns, one new API
route, one new page, two new npm dependencies (`marked`, `sanitize-html`).

## (a) README sections

### Finding images

Every page of the app has a search box (top of the sidebar; on phones in the
navigation drawer, plus a magnifier in the header). Press `/` anywhere to
focus it and `Esc` to close the suggestions or leave the box. While you type,
the box suggests the best eight matches — repositories, tags, image digests
and organizations — and `Enter` opens the full results page (`/search?q=…`).

Search understands:

- **names and descriptions** of repositories (`alp` → `acme/alpine`,
  `globex/alpine-glob`), also as `org/name`;
- **tags** as `org/repo:tag` or just part of a tag name;
- **digests**: paste a full `sha256:…` digest or at least 12 hex characters of
  it to find every manifest that starts with it, together with the tags that
  point at it;
- **organizations** by name or slug.

Results only ever include what you may see: public repositories for everyone,
private ones where you are a member, everything for administrators. The
**Explore** page (`/explore`) has the same filter box plus organization,
visibility (public / private / both) and sort (most pulled, recently updated,
name) controls; the filters live in the URL, so a filtered view can be shared.

### Repository READMEs

Owners and admins of an organization can write a README for each repository
under *Repository → Settings → General → README*: Markdown (GitHub flavoured:
tables, task lists, fenced code) with a live *Preview* tab that renders it
exactly as the repository page will. READMEs are limited to 64 KB and every
save is recorded in the audit log (`repo.readme`).

Rendered READMEs are sanitized: headings, paragraphs, lists, code, tables and
links are kept; scripts, styles, event handlers and other HTML are dropped;
links get `rel="nofollow noopener"`; images are only shown when they are
served over `https://` (relative and `http://` images are removed). Relative
links are left untouched.

When a repository has no README, the repository page shows an **About** block
built from the image itself: the `org.opencontainers.image.*` labels and
annotations of the `latest` tag (else the newest tag) — description, title,
version, vendor, licenses, authors, and links to the source, website and
documentation. Images from Docker Hub, GHCR and most CI pipelines carry these
already, so the block usually appears without anyone writing anything.

### Stars and recently viewed

Every repository page has a **Star** button with the total count; star counts
also show next to repository names on organization pages, Explore and search
results. The dashboard lists your **Starred** repositories and the ones you
**Recently viewed** (eight each, *Show all* expands the list in place). Views
are recorded per user at most once a minute per repository; repositories you
lose access to disappear from both lists.

### Getting started

New users see a *Getting started* card on the dashboard with three steps —
create or join an organization, create an access token, push a first image
(with the exact `docker login` / `docker tag` / `docker push` commands for
this registry and their organization). Steps tick themselves off as soon as
the database shows them done; the card disappears when everything is done or
when it is dismissed.

Administrators get a *Setup checklist* on **Administration → Overview**:
outgoing email, sign-in methods, vulnerability scanning, Prometheus metrics,
garbage-collection and retention schedules, branding, pull rate limits, a
backup reminder and the live health probe — each with its current state and a
link to the page that configures it. It can be dismissed per administrator.

## (b) ARCHITECTURE notes

### Tables and columns (`web/src/db/registry-schema.ts`; web app only, registryd does not read them)

| Table / column | Purpose |
| --- | --- |
| `repositories.readme text NULL` | Markdown README, ≤ 64 KB (`lib/readme-shared.ts` `README_MAX_BYTES`). |
| `user_settings.onboarding_dismissed_at timestamptz NULL` | User closed the dashboard checklist. |
| `user_settings.admin_checklist_dismissed_at timestamptz NULL` | Admin closed the `/admin` checklist. |
| `repository_stars (user_id, repository_id, created_at)` | PK (user, repo); index on `repository_id` for counts. Cascades with user and repository. |
| `repository_visits (user_id, repository_id, last_visited_at, visits)` | PK (user, repo); index `(user_id, last_visited_at)`. Upserted from the repository page inside `after()`; the `ON CONFLICT … WHERE last_visited_at < now() - interval '1 minute'` clause throttles writes. |

registryd's `INSERT INTO repositories` names its columns, so the nullable
`readme` column needs no Go change.

### Migration notes (after `drizzle-kit generate`)

Search uses `ILIKE` and works on a plain database. For large instances the
migration should also carry trigram indexes; drizzle does not emit the
extension, so append this SQL to the generated migration (all statements are
idempotent):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS repositories_name_trgm_idx ON repositories USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS repositories_description_trgm_idx ON repositories USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tags_name_trgm_idx ON tags USING gin (name gin_trgm_ops);
```

`pg_trgm` is a trusted extension: the application role can create it without
superuser rights on PostgreSQL 13+. The indexes are deliberately *not*
declared in the drizzle schema so `drizzle-kit push` on a fresh database
keeps working without the extension.

### Visibility (`lib/viewer.ts`)

`viewerFromSession(session)` → `{ kind: "anonymous" } | { kind: "user", userId, isAdmin }`.
`visibleRepositoriesFilter(viewer)` returns a SQL condition over a
`repositories r` alias — `r.visibility = 'public'` for anonymous, `TRUE` for
admins, `public OR organization_id IN (member's orgs)` otherwise — and every
discovery query (search, explore, starred, recently viewed, organization
search) composes it. `memberOfOrganizationFilter(viewer)` is the same idea
over an `organization o` alias. The rule mirrors `lib/access.ts`.

### Search (`lib/search.ts`, `lib/search-shared.ts`, `app/api/search/route.ts`, `app/(app)/search/page.tsx`)

- `searchRepositories(viewer, { q, orgSlug, visibility, sort, limit })` —
  `ILIKE` on `name`, `description` and `org/name` (pattern escaped with
  `likeEscape`), prefix matches sorted first, then pulls / updated / name.
  Also the Explore page's query.
- `searchTags` (`repo:tag` narrows the repository), `searchDigests`
  (`sha256:<hex>` exact or `LIKE 'sha256:<12+ hex>%'`, with the tags pointing
  at each manifest), `searchOrganizations` (members' orgs, orgs with a public
  repository, admins all).
- `searchAll` powers the results page; `quickSearch` the typeahead (digest
  queries return digests only; otherwise 5 repositories, 2 organizations,
  4 tags, trimmed to 8).
- `GET /api/search?q=` resolves the session from the cookie, answers
  `{ q, hits: SearchHit[] }` with `Cache-Control: private, no-store`, and
  returns nothing under two characters. Anonymous calls get public data only.
- `components/shell/search-box.tsx`: debounced (150 ms) fetch with abort +
  sequence guard, `role="combobox"`/`listbox`, arrow keys, `Enter`,
  `Escape`, global `/` shortcut (ignored while typing elsewhere). Mounted in
  `Sidebar` (desktop and drawer); the mobile header links to `/search`.
- `/search` sits inside the `(app)` group, so like the rest of the UI it
  requires a session (anonymous visitors are redirected to sign-in); the API
  route is what anonymous clients can call.

### READMEs (`lib/readme.ts`, `app/actions/readme.ts`, `components/readme/`)

`renderReadme(markdown)` = `marked` (GFM, synchronous) → `sanitize-html` with
an explicit tag/attribute allowlist, `allowedSchemesByTag.img = ["https"]`,
an `exclusiveFilter` that drops any `<img>` whose `src` is not `https://`,
`transformTags` adding `rel="nofollow noopener"` to links and forcing task
list inputs to disabled checkboxes. `imageAbout(repositoryId)` reads the
`latest`/newest tag's manifest: `manifests.config->config->Labels` first,
then manifest `annotations`; for an index without labels it falls back to
the first child manifest. Actions: `updateReadme` (managers only, 64 KB cap,
audit `repo.readme`, revalidates repo + settings) and `previewReadme`
(signed-in, same renderer). The repository page renders README HTML through
`dangerouslySetInnerHTML` only after sanitizing; styles live in
`components/readme/readme.css` under `.markdown`.

### Stars and visits (`lib/stars.ts`, `app/actions/stars.ts`, `components/star-button.tsx`, `components/repo-shortlist.tsx`)

`toggleStar(repositoryId, starred)` checks the caller can see the repository
(private → needs an org role) and upserts/deletes; the button is optimistic
and reverts on error. `repoListSelect` in `lib/data.ts` now carries
`star_count`, so every `RepoListItem` has `starCount` (shown by
`StarCount` in `RepoTable`, search and Explore). `recordRepositoryVisit` is
called from the repository page via `after()`.

### Onboarding (`lib/onboarding.ts`, `lib/admin-checklist.ts`, `app/actions/onboarding.ts`)

`userOnboarding(userId)`: first non-library organization membership,
`access_tokens` row, and a push (`events` with `actor_type='user'` or
`manifests.pushed_by = 'user:<id>'`). `adminSetupChecklist(userId)` reads
`getInstanceSettings()` (smtp host, providers, metrics, rate limits,
branding source), `listSchedules()` for `gc` / `retention`, `env.clairEnabled`
for the scanner row (the scanning feature branch renames this; adapt the row
there) and `quickHealth()` (database + registry probes, 3 s timeouts).
Dismissals are plain server-action forms writing `user_settings`.

### UI locations

- Sidebar: search box under the brand; mobile header: search icon → `/search`.
- `/search`, `/explore` (filters), `/dashboard` (Getting started, Starred,
  Recently viewed), `/admin` (Setup checklist), repository page (Star button,
  README/About card after the tag list), repository Settings → General
  (README editor).

### Dependencies

`marked` 18.0.11, `sanitize-html` 2.17.7 (+ `@types/sanitize-html` 2.16.1 dev).
