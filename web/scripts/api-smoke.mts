// Contract tests for the REST API against a running web app and its
// database — no registry needed. Seeds an organization, users, tokens, a
// repository and a tagged manifest straight into Postgres, runs the request
// matrix (authentication, visibility, roles, CRUD, exports, conditional
// requests), and removes everything it created. Exit code 1 on any failure.
//
//   API_BASE=http://localhost:3000 DATABASE_URL=postgres://… npx tsx scripts/api-smoke.mts
//
// Operations that go through registryd (tag deletion, retag, copy, scans)
// are skipped unless SMOKE_REGISTRY=1.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const BASE = (process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, "") + "/api/v1";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://chicoree:chicoree@localhost:5432/chicoree";
const WITH_REGISTRY = process.env.SMOKE_REGISTRY === "1";
const RUN = randomBytes(3).toString("hex");
const SLUG = `smoke-${RUN}`;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const secret = (prefix: string) => {
  const s = prefix + randomBytes(30).toString("base64url");
  return { s, hash: createHash("sha256").update(s).digest("hex"), display: s.slice(0, prefix.length + 6) + "…" };
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

interface Res {
  status: number;
  headers: Headers;
  body: unknown;
}
async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined || opts.raw !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, body };
}
async function expect(label: string, method: string, path: string, status: number | number[], opts: Parameters<typeof call>[2] & { verify?: (body: never, res: Res) => boolean | string } = {}): Promise<Res> {
  const res = await call(method, path, opts);
  const wanted = Array.isArray(status) ? status : [status];
  let ok = wanted.includes(res.status);
  let note = "";
  if (ok && opts.verify) {
    const v = opts.verify(res.body as never, res);
    if (v !== true) {
      ok = false;
      note = typeof v === "string" ? v : "verify failed";
    }
  }
  if (ok) passed++;
  else {
    failed++;
    const detail = note || JSON.stringify(res.body).slice(0, 200);
    failures.push(`${label}: got ${res.status}, wanted ${wanted.join("/")} ${detail}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"} [${res.status}] ${label}${note ? ` — ${note}` : ""}`);
  return res;
}
const isObj = (b: unknown): b is Record<string, never> => !!b && typeof b === "object";

// --- Seed ---------------------------------------------------------------------------------------
const adminId = `smoke-admin-${RUN}`;
const userId = `smoke-user-${RUN}`;
const orgId = randomUUID();
const adminTok = secret("chc_pat_");
const readTok = secret("chc_pat_");
const userTok = secret("chc_pat_");
const saTok = secret("chc_sa_");
const digest = "sha256:" + createHash("sha256").update(`smoke-${RUN}`).digest("hex");
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:" + "a".repeat(64), size: 10 }, layers: [] });
let repoId = "";
let pubRepoId = "";

async function seed() {
  await q(`INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at) VALUES ($1, 'Smoke Admin', $2, true, 'admin', now(), now()), ($3, 'Smoke User', $4, true, 'user', now(), now())`, [adminId, `smoke-admin-${RUN}@example.com`, userId, `smoke-user-${RUN}@example.com`]);
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Smoke', $2, now())`, [orgId, SLUG]);
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', now())`, [randomUUID(), orgId, adminId]);
  const [repo] = await q(`INSERT INTO repositories (organization_id, name, description, visibility) VALUES ($1, 'app', 'smoke app', 'private') RETURNING id`, [orgId]);
  const [pub] = await q(`INSERT INTO repositories (organization_id, name, description, visibility) VALUES ($1, 'pub', 'public smoke', 'public') RETURNING id`, [orgId]);
  repoId = repo.id;
  pubRepoId = pub.id;
  for (const id of [repoId, pubRepoId]) {
    await q(`INSERT INTO manifests (repository_id, digest, media_type, size, payload, pushed_by) VALUES ($1, $2, 'application/vnd.oci.image.manifest.v1+json', $3, $4, $5)`, [id, digest, manifest.length, manifest, `user:${adminId}`]);
    await q(`INSERT INTO tags (repository_id, name, manifest_digest) VALUES ($1, 'v1', $2)`, [id, digest]);
  }
  await q(`INSERT INTO access_tokens (user_id, name, token_hash, token_prefix, scope) VALUES ($1, 'smoke-admin', $2, $3, 'write'), ($1, 'smoke-admin-read', $4, $5, 'read'), ($6, 'smoke-user', $7, $8, 'write')`, [adminId, adminTok.hash, adminTok.display, readTok.hash, readTok.display, userId, userTok.hash, userTok.display]);
  await q(`INSERT INTO service_accounts (organization_id, name, token_hash, token_prefix, permission) VALUES ($1, 'smoke-sa', $2, $3, 'admin')`, [orgId, saTok.hash, saTok.display]);
}
async function cleanup() {
  await q(`DELETE FROM organization WHERE slug LIKE $1`, [`smoke-${RUN}%`]);
  await q(`DELETE FROM "user" WHERE id IN ($1, $2)`, [adminId, userId]);
  await q(`DELETE FROM rate_limit_counters WHERE key LIKE 'api|%'`);
  await pool.end();
}

// --- The matrix -----------------------------------------------------------------------------------
async function run() {
  const A = adminTok.s, R = readTok.s, U = userTok.s, SA = saTok.s;

  // index, docs, auth
  await expect("index without credentials", "GET", "", 200, { verify: (b) => (isObj(b) && Array.isArray(b.endpoints) && typeof b.revision === "string") || "no endpoints/revision" });
  await expect("openapi", "GET", "/openapi.json", 200, { verify: (b) => (isObj(b) && b.openapi === "3.1.0") || "not 3.1.0" });
  await expect("unknown path → JSON 404", "GET", "/no/such/thing", 404, { verify: (b) => (isObj(b) && b.code === "not_found") || "no code" });
  await expect("me anonymous → 401", "GET", "/me", 401);
  await expect("bad token → 401", "GET", "/me", 401, { token: "chc_pat_nope" });
  await expect("me admin token", "GET", "/me", 200, { token: A, verify: (b) => (isObj(b) && b.kind === "user" && (b.token as { scope: string }).scope === "write") || "unexpected" });
  await expect("me via basic", "GET", "/me", 200, { headers: { Authorization: "Basic " + Buffer.from(`x:${A}`).toString("base64") } });
  await expect("me service account", "GET", "/me", 200, { token: SA, verify: (b) => (isObj(b) && b.kind === "service-account") || "not sa" });
  await expect("rate limit headers (non-admin)", "GET", "/orgs", 200, { token: U, verify: (_b, r) => !!r.headers.get("x-ratelimit-limit") || "no X-RateLimit-Limit" });

  // visibility
  await expect("anon: org listed via public repo", "GET", `/orgs/${SLUG}`, 200);
  await expect("anon: public repo visible", "GET", `/repos/${SLUG}/pub`, 200);
  await expect("anon: private repo hidden", "GET", `/repos/${SLUG}/app`, 404);
  await expect("anon: public tags", "GET", `/repos/${SLUG}/pub/tags`, 200, { verify: (b) => (isObj(b) && (b.items as unknown[]).length === 1) || "expected 1 tag" });
  await expect("outsider: private repo hidden", "GET", `/repos/${SLUG}/app`, 404, { token: U });
  await expect("outsider: members → 403", "GET", `/orgs/${SLUG}/members`, 403, { token: U });
  await expect("sa: private repo in org", "GET", `/repos/${SLUG}/app`, 200, { token: SA });
  await expect("admin: repo detail", "GET", `/repos/${SLUG}/app`, 200, { token: A, verify: (b) => (isObj(b) && b.tagCount === 1 && typeof b.starred === "boolean") || "shape" });
  await expect("admin: tag detail", "GET", `/repos/${SLUG}/app/tags/v1`, 200, { token: A, verify: (b) => (isObj(b) && b.digest === digest && Array.isArray(b.layers)) || "shape" });
  await expect("admin: manifest detail", "GET", `/repos/${SLUG}/app/manifests/${digest}`, 200, { token: A });
  await expect("admin: bad digest → 400", "GET", `/repos/${SLUG}/app/manifests/sha256:zz`, 400, { token: A });
  await expect("admin: scan gate (unscanned)", "GET", `/repos/${SLUG}/app/manifests/${digest}/scan?fail_on=high`, 200, { token: A, verify: (b) => (isObj(b) && b.passed === null && typeof b.note === "string") || "shape" });
  await expect("admin: vulnerabilities (unscanned)", "GET", `/repos/${SLUG}/app/manifests/${digest}/vulnerabilities`, 200, { token: A, verify: (b) => (isObj(b) && b.scan === null) || "shape" });
  await expect("admin: artifacts", "GET", `/repos/${SLUG}/app/manifests/${digest}/artifacts`, 200, { token: A });
  await expect("admin: untagged", "GET", `/repos/${SLUG}/app/untagged`, 200, { token: A });
  await expect("admin: search", "GET", `/search?q=${SLUG}`, 200, { token: A, verify: (b) => (isObj(b) && (b.total as number) >= 1) || "no hits" });
  await expect("admin: org members", "GET", `/orgs/${SLUG}/members`, 200, { token: A, verify: (b) => (isObj(b) && b.total === 1) || "expected 1 member" });
  await expect("admin: org audit", "GET", `/orgs/${SLUG}/audit`, 200, { token: A });
  await expect("admin: org usage", "GET", `/orgs/${SLUG}/usage`, 200, { token: A });
  await expect("admin: org policies", "GET", `/orgs/${SLUG}/policies`, 200, { token: A });
  await expect("admin: repo policies", "GET", `/repos/${SLUG}/app/policies`, 200, { token: A, verify: (b) => (isObj(b) && b.blockPullsAt === "inherit") || "shape" });

  // limits, usage and user lookups (Administration)
  await expect("outsider: org limits → 403", "GET", `/orgs/${SLUG}/limits`, 403, { token: U });
  await expect("read token: org limits readable", "GET", `/orgs/${SLUG}/limits`, 200, { token: R, verify: (b) => (isObj(b) && b.configured === false) || "shape" });
  await expect("read token: patch limits → 403", "PATCH", `/orgs/${SLUG}/limits`, 403, { token: R, body: { maxMembers: 1 } });
  await expect("org limits patch", "PATCH", `/orgs/${SLUG}/limits`, 200, { token: A, body: { maxMembers: 1, maxPrivateRepositories: 5, label: "Smoke plan" }, verify: (b) => (isObj(b) && (b.limits as { maxMembers: number }).maxMembers === 1 && b.label === "Smoke plan") || "not applied" });
  await expect("org limits: member count 0 → 422", "PATCH", `/orgs/${SLUG}/limits`, 422, { token: A, body: { maxMembers: 0 } });
  await expect("invitation blocked by member limit", "POST", `/orgs/${SLUG}/invitations`, 403, { token: A, body: { email: `smoke-blocked-${RUN}@example.com` } });
  await expect("org usage: members, label, traffic", "GET", `/orgs/${SLUG}/usage`, 200, { token: A, verify: (b) => (isObj(b) && (b.usage as { members: number }).members === 1 && (b.limits as { maxMembers: number }).maxMembers === 1 && b.label === "Smoke plan" && isObj(b.traffic) && /^\d{4}-\d{2}$/.test((b.traffic as { month: string }).month)) || "shape" });
  await expect("org usage: month filter", "GET", `/orgs/${SLUG}/usage?month=2026-01`, 200, { token: A, verify: (b) => (isObj(b) && (b.traffic as { from: string }).from === "2026-01-01") || "wrong month" });
  await expect("org usage: bad month → 422", "GET", `/orgs/${SLUG}/usage?month=2026-13`, 422, { token: A });
  await expect("org limits delete", "DELETE", `/orgs/${SLUG}/limits`, 200, { token: A, verify: (b) => (isObj(b) && b.removed === true) || "not removed" });
  await expect("org limits delete again → removed=false", "DELETE", `/orgs/${SLUG}/limits`, 200, { token: A, verify: (b) => (isObj(b) && b.removed === false) || "shape" });
  await expect("outsider: users → 403", "GET", "/users", 403, { token: U });
  await expect("users by email", "GET", `/users?email=SMOKE-USER-${RUN}@example.com`, 200, { token: A, verify: (b) => (isObj(b) && b.total === 1 && (b.items as { id: string }[])[0].id === userId) || "not found" });
  await expect("users search", "GET", `/users?q=${encodeURIComponent(`-${RUN}@example.com`)}`, 200, { token: A, verify: (b) => (isObj(b) && b.total === 2) || "expected 2" });
  await expect("user detail", "GET", `/users/${userId}`, 200, { token: A, verify: (b) => (isObj(b) && b.email === `smoke-user-${RUN}@example.com` && isObj(b.organizations)) || "shape" });
  await expect("unknown user → 404", "GET", `/users/no-such-${RUN}`, 404, { token: A });
  await expect("user limits patch", "PATCH", `/users/${userId}/limits`, 200, { token: A, body: { maxOrganizations: 1, maxStorageBytes: 1073741824, label: "Free" }, verify: (b) => (isObj(b) && (b.limits as { maxOrganizations: number }).maxOrganizations === 1 && b.configured === true) || "not applied" });
  await expect("user limits: bad type → 422", "PATCH", `/users/${userId}/limits`, 422, { token: A, body: { maxOrganizations: "many" } });
  await expect("user usage", "GET", `/users/${userId}/usage`, 200, { token: A, verify: (b) => (isObj(b) && (b.limits as { maxOrganizations: number }).maxOrganizations === 1 && b.label === "Free" && isObj(b.traffic)) || "shape" });
  await expect("user organizations", "GET", `/users/${adminId}/organizations`, 200, { token: A, verify: (b) => (isObj(b) && (b.total as number) >= 1 && (b.items as { role: string }[]).some((o) => o.role === "owner")) || "shape" });
  await expect("me usage (user token)", "GET", "/me/usage", 200, { token: U, verify: (b) => (isObj(b) && b.user === userId && (b.usage as { organizations: number }).organizations === 0) || "shape" });
  await expect("sa: me usage → 403", "GET", "/me/usage", 403, { token: SA });
  await expect("user limits delete", "DELETE", `/users/${userId}/limits`, 200, { token: A, verify: (b) => (isObj(b) && b.removed === true) || "not removed" });

  // conditional requests
  const first = await expect("etag on GET", "GET", `/orgs/${SLUG}`, 200, { token: A, verify: (_b, r) => (r.headers.get("etag") ?? "").startsWith('W/"') || "no ETag" });
  await expect("If-None-Match → 304", "GET", `/orgs/${SLUG}`, 304, { token: A, headers: { "If-None-Match": first.headers.get("etag") ?? "" } });

  // writes: read-only token, roles, service accounts
  await expect("read token: patch → 403", "PATCH", `/repos/${SLUG}/app`, 403, { token: R, body: { description: "x" } });
  await expect("read token: create repo → 403", "POST", `/orgs/${SLUG}/repos`, 403, { token: R, body: { name: "x" } });
  await expect("sa: create repo → 403", "POST", `/orgs/${SLUG}/repos`, 403, { token: SA, body: { name: "x" } });
  await expect("sa: star → 403", "PUT", `/repos/${SLUG}/pub/star`, 403, { token: SA });
  await expect("outsider: star public repo", "PUT", `/repos/${SLUG}/pub/star`, 200, { token: U, verify: (b) => (isObj(b) && b.starred === true) || "not starred" });
  await expect("outsider: starred list", "GET", "/me/starred", 200, { token: U, verify: (b) => (isObj(b) && b.total === 1) || "expected 1" });
  await expect("outsider: unstar", "DELETE", `/repos/${SLUG}/pub/star`, 200, { token: U });

  // repositories CRUD
  await expect("create repo: bad name → 422", "POST", `/orgs/${SLUG}/repos`, 422, { token: A, body: { name: "Bad Name" } });
  await expect("create repo", "POST", `/orgs/${SLUG}/repos`, 201, { token: A, body: { name: "created", visibility: "public", description: "made by smoke" } });
  await expect("create repo: duplicate → 409", "POST", `/orgs/${SLUG}/repos`, 409, { token: A, body: { name: "created" } });
  await expect("patch repo", "PATCH", `/repos/${SLUG}/created`, 200, { token: A, body: { description: "changed", visibility: "private" }, verify: (b) => (isObj(b) && b.visibility === "private" && b.description === "changed") || "not applied" });
  await expect("patch repo: bad json → 400", "PATCH", `/repos/${SLUG}/created`, 400, { token: A, raw: "not json" });
  await expect("repo policies patch", "PATCH", `/repos/${SLUG}/created/policies`, 200, { token: A, body: { blockPullsAt: "critical" }, verify: (b) => (isObj(b) && b.blockPullsAt === "critical") || "not applied" });
  await expect("delete repo", "DELETE", `/repos/${SLUG}/created`, 200, { token: A });
  await expect("deleted repo → 404", "GET", `/repos/${SLUG}/created`, 404, { token: A });

  // organization management
  await expect("org policies patch", "PATCH", `/orgs/${SLUG}/policies`, 200, { token: A, body: { blockPullsAt: "high", defaultVisibility: "public" }, verify: (b) => (isObj(b) && (b.pullPolicy as { blockPullsAt: string }).blockPullsAt === "high") || "not applied" });
  await expect("org rename", "PATCH", `/orgs/${SLUG}`, 200, { token: A, body: { name: "Smoke Renamed" }, verify: (b) => (isObj(b) && b.name === "Smoke Renamed") || "not applied" });
  const sa = await expect("service account create", "POST", `/orgs/${SLUG}/service-accounts`, 201, { token: A, body: { name: "ci", permission: "push", expiresInDays: 7 }, verify: (b) => (isObj(b) && typeof b.secret === "string") || "no secret" });
  const saId = (sa.body as { id: string }).id;
  await expect("service account secret works", "GET", "/me", 200, { token: (sa.body as { secret: string }).secret });
  await expect("service account rotate", "POST", `/orgs/${SLUG}/service-accounts/${saId}/rotate`, 200, { token: A });
  await expect("service account delete", "DELETE", `/orgs/${SLUG}/service-accounts/${saId}`, 200, { token: A });
  const inv = await expect("invitation create", "POST", `/orgs/${SLUG}/invitations`, 201, { token: A, body: { email: `smoke-invitee-${RUN}@example.com`, role: "member" } });
  await expect("invitation cancel", "DELETE", `/orgs/${SLUG}/invitations/${(inv.body as { id: string }).id}`, 200, { token: A });
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'viewer', now())`, [randomUUID(), orgId, userId]);
  await expect("member role change", "PATCH", `/orgs/${SLUG}/members/${userId}`, 200, { token: A, body: { role: "member" }, verify: (b) => (isObj(b) && b.role === "member") || "not applied" });
  await expect("last owner protected", "PATCH", `/orgs/${SLUG}/members/${adminId}`, 409, { token: A, body: { role: "admin" } });
  await expect("member remove", "DELETE", `/orgs/${SLUG}/members/${userId}`, 200, { token: A });
  const hook = await expect("webhook create", "POST", `/orgs/${SLUG}/webhooks`, 201, { token: A, body: { name: "smoke", url: "http://127.0.0.1:9/hook", events: ["push"] } });
  const hookId = (hook.body as { id: string }).id;
  await expect("webhook patch", "PATCH", `/orgs/${SLUG}/webhooks/${hookId}`, 200, { token: A, body: { enabled: false }, verify: (b) => (isObj(b) && b.enabled === false) || "not applied" });
  await expect("webhook test (unreachable receiver)", "POST", `/orgs/${SLUG}/webhooks/${hookId}/test`, 200, { token: A, verify: (b) => (isObj(b) && b.ok === false) || "expected ok=false" });
  await expect("webhook delete", "DELETE", `/orgs/${SLUG}/webhooks/${hookId}`, 200, { token: A });
  const ident = await expect("ci identity create", "POST", `/orgs/${SLUG}/ci-identities`, 201, { token: A, body: { name: "gh", issuer: "https://token.actions.githubusercontent.com", subject: "repo:smoke/app:ref:refs/heads/main" } });
  await expect("exchange: garbage token → 401", "POST", "/auth/exchange", 401, { body: { token: "not.a.jwt" } });
  await expect("ci identity delete", "DELETE", `/orgs/${SLUG}/ci-identities/${(ident.body as { id: string }).id}`, 200, { token: A });
  await expect("create org", "POST", "/orgs", 201, { token: A, body: { slug: `${SLUG}-b`, name: "Smoke B" } });
  await expect("delete org", "DELETE", `/orgs/${SLUG}-b`, 200, { token: A });

  // --- Teams and per-repository permissions (2026-09-07.1) ---
  await expect("outsider: create team → 403", "POST", `/orgs/${SLUG}/teams`, 403, { token: U, body: { name: "Backend" } });
  const team = await expect("admin: create team", "POST", `/orgs/${SLUG}/teams`, 201, { token: A, body: { name: "Backend", description: "owns app" }, verify: (b) => (isObj(b) && b.slug === "backend" && b.memberCount === 0) || "bad team" });
  const teamId = (team.body as { id: string }).id;
  await expect("admin: list teams", "GET", `/orgs/${SLUG}/teams`, 200, { token: A, verify: (b) => (isObj(b) && b.total === 1) || "expected 1 team" });
  await expect("admin: add non-member to team → 422", "PUT", `/orgs/${SLUG}/teams/backend/members/${userId}`, 422, { token: A });
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'viewer', now())`, [randomUUID(), orgId, userId]);
  await expect("admin: add viewer to team", "PUT", `/orgs/${SLUG}/teams/backend/members/${userId}`, 200, { token: A, verify: (b) => (isObj(b) && (b.members as unknown[]).length === 1) || "member missing" });
  await expect("viewer: team detail by id", "GET", `/orgs/${SLUG}/teams/${teamId}`, 200, { token: U, verify: (b) => (isObj(b) && b.slug === "backend") || "wrong team" });
  await expect("admin: rename team", "PATCH", `/orgs/${SLUG}/teams/backend`, 200, { token: A, body: { name: "Platform", slug: "platform" }, verify: (b) => (isObj(b) && b.slug === "platform") || "rename failed" });
  await expect("viewer: change repo → 403", "PATCH", `/repos/${SLUG}/app`, 403, { token: U, body: { description: "nope" } });
  await expect("viewer: size history readable", "GET", `/repos/${SLUG}/app/size-history?days=30`, 200, { token: U, verify: (b) => (isObj(b) && b.days === 30 && (b.items as unknown[]).length === 30) || "bad series" });
  await expect("viewer: access list → 403", "GET", `/repos/${SLUG}/app/access`, 403, { token: U });
  await expect("admin: grant team admin on app", "PUT", `/repos/${SLUG}/app/access/team/${teamId}`, 200, { token: A, body: { permission: "admin" }, verify: (b) => (isObj(b) && b.permission === "admin" && b.subjectType === "team") || "bad grant" });
  await expect("viewer+team grant: change repo → 200", "PATCH", `/repos/${SLUG}/app`, 200, { token: U, body: { description: "granted" } });
  await expect("viewer+team grant: access list shows manage", "GET", `/repos/${SLUG}/app/access`, 200, { token: U, verify: (b) => (isObj(b) && b.total === 1 && (b.you as { manage: boolean }).manage === true) || "you.manage false" });
  await expect("admin: bad permission → 422", "PUT", `/repos/${SLUG}/app/access/user/${userId}`, 422, { token: A, body: { permission: "root" } });
  await expect("admin: grant user pull", "PUT", `/repos/${SLUG}/app/access/user/${userId}`, 200, { token: A, body: { permission: "pull" } });
  await expect("admin: remove team grant", "DELETE", `/repos/${SLUG}/app/access/team/${teamId}`, 200, { token: A });
  await expect("viewer (pull grant only): change repo → 403", "PATCH", `/repos/${SLUG}/app`, 403, { token: U, body: { description: "nope" } });
  await expect("admin: delete team", "DELETE", `/orgs/${SLUG}/teams/platform`, 200, { token: A });
  await expect("admin: teams empty", "GET", `/orgs/${SLUG}/teams`, 200, { token: A, verify: (b) => (isObj(b) && b.total === 0) || "team still there" });

  if (WITH_REGISTRY) {
    await expect("retag (registry)", "PUT", `/repos/${SLUG}/app/tags/v2`, 201, { token: A, body: { digest } });
    await expect("delete tag (registry)", "DELETE", `/repos/${SLUG}/app/tags/v2`, 200, { token: A });
  } else {
    console.log("skip registry-backed operations (set SMOKE_REGISTRY=1)");
  }
}

await seed();
try {
  await run();
} finally {
  await cleanup();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
