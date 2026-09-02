// The "library" organization owns top-level image names: `registry/nginx`
// is stored and served as `library/nginx`, mirroring docker.io semantics. It
// is created with the first administrator, owned by admins, and cannot be
// deleted or renamed.
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "@/db";
import { member, organization } from "@/db/schema";

export const LIBRARY_SLUG = "library";
export const LIBRARY_NAME = "Library";

let ensured = false;

/** Idempotently create the library organization and make the user an owner. */
export async function ensureLibraryOrg(adminUserId?: string): Promise<void> {
  if (ensured && !adminUserId) return;
  let org = await db.query.organization.findFirst({ where: eq(organization.slug, LIBRARY_SLUG) });
  if (!org) {
    [org] = await db
      .insert(organization)
      .values({
        id: randomUUID(),
        name: LIBRARY_NAME,
        slug: LIBRARY_SLUG,
        createdAt: new Date(),
        metadata: JSON.stringify({ system: true }),
      })
      .onConflictDoNothing()
      .returning();
    org ??= (await db.query.organization.findFirst({ where: eq(organization.slug, LIBRARY_SLUG) }))!;
  }
  if (adminUserId) {
    const existing = await db.query.member.findFirst({
      where: and(eq(member.organizationId, org.id), eq(member.userId, adminUserId)),
    });
    if (!existing) {
      await db.insert(member).values({
        id: randomUUID(),
        organizationId: org.id,
        userId: adminUserId,
        role: "owner",
        createdAt: new Date(),
      });
    }
  }
  ensured = true;
}

export function isLibrary(orgSlug: string): boolean {
  return orgSlug === LIBRARY_SLUG;
}

/** The path clients use: `nginx` for library repos, `org/repo` otherwise. */
export function imagePath(orgSlug: string, repoName: string): string {
  return isLibrary(orgSlug) ? repoName : `${orgSlug}/${repoName}`;
}

/** Full docker reference, e.g. `registry.example.com/nginx:1.27`. */
export function imageReference(host: string, orgSlug: string, repoName: string, ref?: string): string {
  const base = `${host}/${imagePath(orgSlug, repoName)}`;
  if (!ref) return base;
  return ref.startsWith("sha256:") ? `${base}@${ref}` : `${base}:${ref}`;
}

/** Split a scope/repo name into org + repo; single segments belong to library. */
export function splitImagePath(name: string): { orgSlug: string; repoName: string } | null {
  const parts = name.split("/");
  if (parts.length === 1 && parts[0]) return { orgSlug: LIBRARY_SLUG, repoName: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { orgSlug: parts[0], repoName: parts[1] };
  return null;
}
