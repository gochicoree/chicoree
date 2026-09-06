// The "library" organization owns top-level image names: `registry/nginx`
// is stored and served as `library/nginx`, mirroring docker.io semantics. It
// is created with the first administrator, owned by admins, and cannot be
// deleted or renamed.
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "@/db";
import { member, organization } from "@/db/schema";

import { LIBRARY_NAME, LIBRARY_SLUG } from "./library-shared";

export { LIBRARY_SLUG, LIBRARY_NAME, isLibrary, imagePath, imageReference, displayPath, splitImagePath } from "./library-shared";

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

export { repoHref } from "./proxy-shared";
