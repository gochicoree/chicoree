// Group → role bindings, shared by every sign-in source that can tell us the
// user's groups: LDAP (group DNs), GitHub (organizations and teams), Google
// (Workspace groups and the hosted domain) and OIDC (a groups claim).
//
//   AUTH_GROUP_BINDINGS="cn=registry-admins,ou=groups,dc=example,dc=com => admin;
//                        github:acme/platform => acme:owner;
//                        google:example.com => acme:viewer;
//                        oidc:developers => acme:member"
//
// Entries are separated by ";" (or newlines). Group identifiers:
//   LDAP    a full DN or just the CN of the group (optionally "ldap:"-prefixed)
//   GitHub  github:<org> or github:<org>/<team-slug>
//   Google  google:<group email> or google:<workspace domain>
//   OIDC    oidc:<value of the groups claim>
// Targets are "admin" (instance administrator) or "<org-slug>:<role>". When
// several bindings hit the same organization the highest role wins.
//
// Bindings are authoritative for what they cover, per source: after a GitHub
// login only the github:* bindings are consulted — a user who matches none of
// them for an organization that github:* bindings mention is removed from it,
// and if a github:* binding targets "admin" the instance role follows it.
// Organizations no binding of that source mentions are never touched, and the
// last owner of an organization is never removed.
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { member, organization, user as userTable } from "@/db/schema";
import { getInstanceSettings } from "./instance-settings";
import { ORG_ROLE_NAMES, type OrgRole } from "./org-roles";
import { ensureLibraryOrg } from "./library";

export type GroupSource = "ldap" | "github" | "google" | "oidc";
export type BindingTarget = { kind: "admin" } | { kind: "org"; slug: string; role: OrgRole };
export interface GroupBinding {
  source: GroupSource;
  /** The pattern without its source prefix. */
  group: string;
  target: BindingTarget;
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const PREFIX = /^(ldap|github|google|oidc):/i;

export function parseGroupBindings(raw: string): GroupBinding[] {
  return raw
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.+?)\s*=>\s*(\S+)$/);
      if (!m) {
        throw new Error(
          `AUTH_GROUP_BINDINGS: cannot parse "${entry}" (expected "<group> => admin" or "<group> => <org-slug>:<role>")`,
        );
      }
      const [, pattern, target] = m;
      const prefix = pattern.match(PREFIX);
      const source = (prefix ? prefix[1].toLowerCase() : "ldap") as GroupSource;
      const group = prefix ? pattern.slice(prefix[0].length).trim() : pattern.trim();
      if (!group) throw new Error(`AUTH_GROUP_BINDINGS: empty group in "${entry}"`);
      if (target === "admin") return { source, group, target: { kind: "admin" } };
      const sep = target.lastIndexOf(":");
      const slug = sep > 0 ? target.slice(0, sep) : "";
      const role = sep > 0 ? target.slice(sep + 1) : "";
      if (!slug || !(ORG_ROLE_NAMES as string[]).includes(role)) {
        throw new Error(
          `AUTH_GROUP_BINDINGS: "${target}" must be "admin" or "<org-slug>:<${ORG_ROLE_NAMES.join("|")}>"`,
        );
      }
      return { source, group, target: { kind: "org", slug, role: role as OrgRole } };
    });
}

/** The bindings currently configured (admin panel, else AUTH_GROUP_BINDINGS). */
export async function loadGroupBindings(): Promise<GroupBinding[]> {
  return parseGroupBindings((await getInstanceSettings()).bindings);
}

/** The bindings that refer to groups from the given source. */
export function bindingsFor(source: GroupSource, bindings: GroupBinding[]): GroupBinding[] {
  return bindings.filter((b) => b.source === source);
}

function normalizeDn(dn: string): string {
  return dn.toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s*=\s*/g, "=").trim();
}

/**
 * LDAP groups match by full DN or by the value of the first RDN (the CN);
 * every other source matches its identifiers exactly ("acme/platform",
 * "example.com", "devs" — without the source prefix). Case-insensitive.
 */
export function groupMatches(source: GroupSource, identifier: string, pattern: string): boolean {
  if (source !== "ldap") return identifier.toLowerCase() === pattern.toLowerCase();
  const g = normalizeDn(identifier);
  const p = normalizeDn(pattern);
  if (g === p) return true;
  if (p.includes("=")) return false;
  return g.split(",")[0]?.split("=")[1] === p;
}

export interface ResolvedBindings {
  /** null when this source has no admin binding (leave the role alone). */
  admin: boolean | null;
  orgRoles: Map<string, OrgRole>;
  /** Every org slug this source's bindings mention, matched or not. */
  managedOrgs: Set<string>;
}

export function resolveBindings(source: GroupSource, groups: string[], bindings: GroupBinding[]): ResolvedBindings {
  const managedOrgs = new Set<string>();
  const orgRoles = new Map<string, OrgRole>();
  let adminConfigured = false;
  let admin = false;
  for (const b of bindingsFor(source, bindings)) {
    if (b.target.kind === "admin") adminConfigured = true;
    else managedOrgs.add(b.target.slug);
    if (!groups.some((g) => groupMatches(source, g, b.group))) continue;
    if (b.target.kind === "admin") {
      admin = true;
    } else {
      const { slug, role } = b.target;
      const current = orgRoles.get(slug);
      if (!current || ROLE_RANK[role] > ROLE_RANK[current]) orgRoles.set(slug, role);
    }
  }
  return { admin: adminConfigured ? admin : null, orgRoles, managedOrgs };
}

/** Apply this source's bindings to a user, given the groups from their login. */
export async function syncGroupBindings(source: GroupSource, userId: string, groups: string[]): Promise<void> {
  const bindings = await loadGroupBindings();
  if (bindingsFor(source, bindings).length === 0) return;
  const { admin, orgRoles, managedOrgs } = resolveBindings(source, groups, bindings);

  if (admin !== null) {
    const u = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
    const wanted = admin ? "admin" : "user";
    if (u && (u.role ?? "user") !== wanted) {
      await db.update(userTable).set({ role: wanted }).where(eq(userTable.id, userId));
    }
    if (admin) await ensureLibraryOrg(userId);
  }

  if (managedOrgs.size === 0) return;
  const orgs = await db.query.organization.findMany({
    where: inArray(organization.slug, [...managedOrgs]),
  });
  for (const org of orgs) {
    const role = orgRoles.get(org.slug);
    const existing = await db.query.member.findFirst({
      where: and(eq(member.organizationId, org.id), eq(member.userId, userId)),
    });
    if (role) {
      if (!existing) {
        await db.insert(member).values({
          id: randomUUID(),
          organizationId: org.id,
          userId,
          role,
          createdAt: new Date(),
        });
      } else if (existing.role !== role) {
        if (existing.role === "owner" && (await isLastOwner(org.id))) continue;
        await db.update(member).set({ role }).where(eq(member.id, existing.id));
      }
    } else if (existing) {
      if (existing.role === "owner" && (await isLastOwner(org.id))) continue;
      await db.delete(member).where(eq(member.id, existing.id));
    }
  }
}

async function isLastOwner(organizationId: string): Promise<boolean> {
  const [{ value }] = await db
    .select({ value: count() })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")));
  return value <= 1;
}
