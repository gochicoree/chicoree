# Pictures for organizations, repositories and users

Working notes for the `logos` branch. Part (a) is ready to fold into `README.md`,
part (b) into `ARCHITECTURE.md`.

---

## (a) README-ready sections

### Pictures

Organizations, repositories and people can all have a picture. It replaces the
generic icon or the initial-letter monogram everywhere that entity shows up —
the sidebar and the mobile drawer, the organization list, `/explore`, search
results and the search typeahead, every repository table, the dashboard
shortlists and activity feed, the organization and repository page headers, the
member list, the "pushed by" line on a tag, and the administration screens.

Pictures are **PNG, SVG, JPEG or WebP**, at most **64 KB**. That is the same cap
and the same validation the instance logo uses (Administration → Branding), so
an SVG that carries a `<script>`, an event handler (`onload=…`) or a link to an
external file is refused. Nothing is resized or re-encoded: what you upload is
what is served.

Nothing is inherited. A repository without a picture of its own shows the
repository icon — never its organization's picture — and an account without an
avatar keeps its monogram.

**Setting one**

| Picture | Where |
| --- | --- |
| Organization | Organization → Settings → General → *Organization picture* (owners and admins) |
| Repository | Repository → Settings → General → *Repository picture* (owners and admins) |
| Your avatar | Settings → Profile → *Your avatar* |

Pick a file, check the preview, then **Save picture**. *Remove picture* followed
by Save clears it and brings the icon or monogram back.

Instance administrators can also set or clear a picture for somebody else:

- `/admin/organizations/<id>` → *Organization picture*
- `/admin/users/<id>` → *Avatar*

Every change — by an owner or by an administrator — is written to the audit log
(`org.logo`, `repo.logo`, `user.avatar`, `admin.org.logo`, `admin.user.avatar`),
including the media type and byte count, or `removed: true`.

**Who can see them**

Organization and user pictures are visible to any signed-in user. A repository's
picture follows the repository: public ones are open to anonymous visitors,
private ones only to members (and instance administrators). Signed-out visitors
get nothing for organizations and people.

**Why the pictures are not embedded in the page**

A 64 KB picture repeated on every row of a fifty-row table would add megabytes to
the HTML. Pictures are served from their own address instead
(`/api/logo/<kind>/<id>`), cached by the browser for a year, and re-fetched only
when the picture actually changes. Listing pages never contain image data.

---

## (b) ARCHITECTURE-ready notes

### Storage

No new tables. Three existing columns hold the picture as a `data:` URL, exactly
as instance branding already stores the instance logo:

| Entity | Table | Column | Note |
| --- | --- | --- | --- |
| Organization | `organization` | `logo` | better-auth's own column |
| User | `user` | `image` | better-auth's own column |
| Repository | `repositories` | `logo` | **new**, nullable `text` |

`repositories.logo` is the only schema change:
`ALTER TABLE "repositories" ADD COLUMN "logo" text;` — plain DDL that
`drizzle-kit generate` emits on its own, no data migration and no backfill.
registryd neither reads nor writes it, so `internal/store/store.go` is unchanged
(every repository query there lists its columns explicitly).

### Validation — one implementation, four uses

`web/src/lib/branding-shared.ts` is the single source of truth, shared by the
instance logo and the three entity pictures, and it runs on the client (live
feedback while picking a file) and again in the server action (the check that
counts):

- `LOGO_MEDIA_TYPES` — `image/png`, `image/svg+xml`, `image/jpeg`, `image/webp`
  (JPEG and WebP were added for this feature; rasters need no sanitising).
- `LOGO_MAX_BYTES` — 64 KB, decoded, for every picture.
- `parseLogoDataUrl(dataUrl)` — splits a `data:` URL into media type, canonical
  base64 and bytes; rejects anything else.
- `validateLogoDataUrl(dataUrl)` — media type, size, real magic bytes
  (`\x89PNG`, `\xFF\xD8\xFF`, `RIFF….WEBP`), and for SVG: contains `<svg>` and
  carries no `<script>`, `javascript:`, `on…=` handler, `<foreignObject>`,
  `<iframe>`, `<embed>`, `<object>` or external `xlink:href` (a `#fragment` or
  an inline `data:image` reference is allowed).

The server action stores the normalised `data:<type>;base64,<payload>` form
(whitespace stripped), so the hash below is stable for identical bytes.

`web/src/lib/logo-shared.ts` adds the pure entity-side pieces (`LogoKind`,
`LogoRef`, `logoSrc`, `logoRef`, `isLogoKind`) and re-exports the validation, so
client components never reach for a module that touches the database.

### Serving: `GET /api/logo/<kind>/<id>?v=<version>`

`web/src/app/api/logo/[kind]/[id]/route.ts`. `<kind>` is `organization`,
`repository` or `user`.

| | |
| --- | --- |
| **200** | the decoded bytes, `Content-Type` from the data URL (`image/svg+xml; charset=utf-8` for SVG), `Content-Length`, `ETag`, `Cache-Control`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` |
| **304** | when `If-None-Match` carries the current ETag (or `*`); same `ETag` and `Cache-Control`, no body |
| **404** | unknown kind, no such entity, no picture, or no read access — the same answer for all four, so the route leaks nothing |

- **ETag** — strong, `"<md5 of the stored data URL>"`. MD5 is a cache key here,
  not a security primitive.
- **Cache-Control** — `public, max-age=31536000, immutable`, except a **private
  repository's** picture, which is `private, max-age=31536000, immutable` so a
  shared proxy cannot hand it to somebody without access.
- **Version parameter** — `?v=` is the first 8 hex digits of that same MD5. It
  is never validated; it exists so that replacing a picture changes the URL and
  the year-long cache entry is bypassed instead of revalidated. Listings compute
  it in SQL (`substr(md5(<column>), 1, 8)`, `logoVersionSql` in
  `web/src/lib/logo.ts`) so a page of fifty rows never loads a single byte of
  image data; `logoVersionOf(dataUrl)` does the same in Node for the few places
  that already hold the row.
- **Access** — `repository`: public repositories are open (anonymous included),
  private ones require `getOrgRole(repo.organizationId)`, mirroring
  `/api/artifacts/...`. `organization` and `user`: any signed-in session.

### Server actions — `web/src/app/actions/logos.ts`

| Action | Guard | Audit action |
| --- | --- | --- |
| `saveOrganizationLogo` | `MANAGER_ROLES` in the organization | `org.logo` |
| `saveRepositoryLogo` | `MANAGER_ROLES` in the owning organization | `repo.logo` |
| `saveUserAvatar` | the signed-in user, on themselves | `user.avatar` |
| `adminSaveOrganizationLogo` | `requireAdmin()` | `admin.org.logo` |
| `adminSaveUserAvatar` | `requireAdmin()` | `admin.user.avatar` |

All five take one `logoDataUrl` field — empty means *remove* — validate it
server-side, store the normalised value and `revalidatePath` the pages that show
it. Details recorded: `{ mediaType, bytes }` or `{ removed: true }`, plus
`by: "admin"` for the admin variants.

### UI

- `web/src/components/entity-logo.tsx` — `<EntityLogo kind name logo size shape
  fallback />`. With a `LogoRef` it renders an `<img>` at exactly `size` pixels
  pointing at the route; without one it renders the same-sized box holding the
  call site's existing icon, or the default (a `Container` glyph for
  organizations and repositories, an initial-letter circle for users). Because
  the fallback box is the same size as the picture, rows line up whether or not
  a picture is set. The fallback wrapper is `inline-flex`, so the component works
  in a flex row and inline in a sentence (the activity feed) alike.
- `web/src/components/logo-upload.tsx` — `<LogoUploadCard>`, the upload /
  preview / remove card, modelled on the instance-branding form: it reads the
  file into a data URL with `FileReader`, checks size and format in the browser,
  shows a live preview and posts the data URL to the server action it is handed
  as a prop. This is the only place a data URL is inlined, and only ever for one
  entity on a settings page.
- `web/src/components/ui/card.tsx` — `CardHeader` gained an optional `icon`
  slot, used by the admin organization and user detail headers.

### Where the queries carry the version

`RepoListItem`, `OrgWithMeta`, `NavOrgs`, `AdminOrgRow`, `OrgHit`, `SearchHit`,
`ActivityItem`, `listMembersWithUsers`, `listAdminUsers` and
`getAdminUserDetail().memberships` each gained a nullable `logoVersion` (the
activity feed also gained `actorUserId`). Pages turn that into a `LogoRef` with
`logoRef(kind, id, version)`, which returns `null` when there is no picture — the
signal `EntityLogo` uses to fall back.

### Deliberate non-goals

- **No inheritance.** A repository never borrows its organization's picture.
- **No image processing.** No resizing, no format conversion, no server-side
  rasterising; the 64 KB cap keeps that unnecessary.
- **No new environment variables, services or npm dependencies.**
