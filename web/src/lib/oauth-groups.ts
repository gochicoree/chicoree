// Group lookup for OAuth sign-ins, feeding lib/group-bindings.ts with plain
// identifiers ("acme/platform", "example.com", "devs" — the provider is
// passed alongside, so no prefixes here). Runs from
// better-auth's account create/update hooks, i.e. on every social login
// (better-auth refreshes the stored tokens each time).
//
//   GitHub  organizations and teams via the API (needs the read:org scope,
//           which auth.ts requests whenever a github:* binding exists)
//   Google  the hosted domain from the ID token, plus Workspace groups via the
//           Cloud Identity API when a binding names a group address
//   OIDC    the groups claim of the ID token (OIDC_GROUPS_CLAIM)
//
// A lookup that fails, or a token without the needed scope, leaves the user's
// roles untouched — removals only happen on a definitive answer.
import { bindingsFor, loadGroupBindings, syncGroupBindings, type GroupBinding, type GroupSource } from "./group-bindings";
import { getInstanceSettings } from "./instance-settings";

export interface OAuthAccountLike {
  userId: string;
  providerId: string;
  accessToken?: string | null;
  idToken?: string | null;
}

const OAUTH_SOURCES: GroupSource[] = ["github", "google", "oidc"];

export function decodeJwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whether a binding names a Google group address (needs the API) rather than just a domain. */
export function needsGoogleGroupsApi(bindings: GroupBinding[]): boolean {
  return bindingsFor("google", bindings).some((b) => b.group.includes("@"));
}

async function githubGroups(accessToken: string | null | undefined): Promise<string[] | null> {
  if (!accessToken) return null;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "chicoree-registry",
  };
  const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", { headers });
  if (!orgsRes.ok) throw new Error(`GitHub /user/orgs responded ${orgsRes.status}`);
  const granted = (orgsRes.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
  if (!granted.some((s) => s === "read:org" || s === "write:org" || s === "admin:org")) {
    console.warn("[group-bindings] GitHub token lacks read:org (granted before bindings were configured); roles left unchanged until the user re-authorizes");
    return null;
  }
  const orgs = (await orgsRes.json()) as { login: string }[];
  const teamsRes = await fetch("https://api.github.com/user/teams?per_page=100", { headers });
  if (!teamsRes.ok) throw new Error(`GitHub /user/teams responded ${teamsRes.status}`);
  const teams = (await teamsRes.json()) as { slug: string; organization: { login: string } }[];
  return [...orgs.map((o) => o.login), ...teams.map((t) => `${t.organization.login}/${t.slug}`)].map((s) =>
    s.toLowerCase(),
  );
}

async function googleGroups(account: OAuthAccountLike, bindings: GroupBinding[]): Promise<string[] | null> {
  const claims = decodeJwtClaims(account.idToken);
  if (!claims) return null;
  const groups: string[] = [];
  if (typeof claims.hd === "string" && claims.hd) groups.push(claims.hd.toLowerCase());
  if (needsGoogleGroupsApi(bindings)) {
    const email = typeof claims.email === "string" ? claims.email : null;
    if (!account.accessToken || !email) return null;
    const url = new URL("https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchDirectGroups");
    url.searchParams.set(
      "query",
      `member_key_id == '${email.replace(/'/g, "")}' && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`,
    );
    url.searchParams.set("pageSize", "200");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
    if (!res.ok) throw new Error(`Cloud Identity searchDirectGroups responded ${res.status}`);
    const data = (await res.json()) as { memberships?: { groupKey?: { id?: string } }[] };
    for (const m of data.memberships ?? []) {
      if (m.groupKey?.id) groups.push(m.groupKey.id.toLowerCase());
    }
  }
  return groups;
}

function oidcGroups(account: OAuthAccountLike, oidc: { name: string; groupsClaim: string }): string[] | null {
  const claims = decodeJwtClaims(account.idToken);
  if (!claims) return null;
  if (!(oidc.groupsClaim in claims)) {
    console.warn(`[group-bindings] ID token from ${oidc.name} carries no "${oidc.groupsClaim}" claim; add it to the ID token (or change the groups claim / scopes in the admin settings) — roles left unchanged`);
    return null;
  }
  const raw = claims[oidc.groupsClaim];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  return list.filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => v.toLowerCase());
}

/** Called after every social sign-in; never throws. */
export async function syncOAuthGroups(account: OAuthAccountLike): Promise<void> {
  const source = account.providerId as GroupSource;
  if (!OAUTH_SOURCES.includes(source)) return;
  const bindings = await loadGroupBindings();
  if (bindingsFor(source, bindings).length === 0) return;
  try {
    const settings = await getInstanceSettings();
    const groups =
      source === "github"
        ? await githubGroups(account.accessToken)
        : source === "google"
          ? await googleGroups(account, bindings)
          : oidcGroups(account, settings.oidc);
    if (groups === null) return;
    await syncGroupBindings(source, account.userId, groups);
  } catch (e) {
    console.error(`[group-bindings] ${source} group lookup failed; roles left unchanged`, e);
  }
}
