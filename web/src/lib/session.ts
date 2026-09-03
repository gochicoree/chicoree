import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getAuth } from "./auth";
import { db } from "@/db";
import { member, organization } from "@/db/schema";

/** Session lookup, deduplicated per request. */
export const getSession = cache(async () => {
  const auth = await getAuth();
  return auth.api.getSession({ headers: await headers() });
});

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

export async function requireAdmin() {
  const session = await requireSession();
  if (session.user.role !== "admin") redirect("/dashboard");
  return session;
}

import type { OrgRole } from "./org-roles";
export type { OrgRole };

/** The caller's role in an organization, or null. Instance admins act as owners. */
export const getOrgRole = cache(async (organizationId: string): Promise<OrgRole | null> => {
  const session = await getSession();
  if (!session) return null;
  if (session.user.role === "admin") return "owner";
  const m = await db.query.member.findFirst({
    where: and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)),
  });
  return (m?.role as OrgRole) ?? null;
});

/** Load an org by slug and the caller's role in it. */
export const getOrgContext = cache(async (slug: string) => {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, slug) });
  if (!org) return null;
  const role = await getOrgRole(org.id);
  return { org, role };
});
