// Service accounts as the API shows them: the row plus its repository
// allowlist resolved to names. The secret itself only appears in the
// create and rotate responses.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { repositories, serviceAccounts } from "@/db/schema";
import { getInstanceSettings } from "@/lib/instance-settings";
import { resolveExpiry } from "@/lib/token-policy-shared";
import { iso, unprocessable } from "./respond";

export const SA_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type ServiceAccountRow = typeof serviceAccounts.$inferSelect & { repositoryNames: string[] | null };

export async function serviceAccountRows(organizationId: string, id?: string): Promise<ServiceAccountRow[]> {
  const rows = await db.query.serviceAccounts.findMany({
    where: id ? and(eq(serviceAccounts.organizationId, organizationId), eq(serviceAccounts.id, id)) : eq(serviceAccounts.organizationId, organizationId),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
  const ids = [...new Set(rows.flatMap((r) => r.repositoryIds ?? []))];
  const names = ids.length ? await db.query.repositories.findMany({ where: inArray(repositories.id, ids), columns: { id: true, name: true } }) : [];
  const byId = new Map(names.map((r) => [r.id, r.name]));
  void sql;
  return rows.map((r) => ({ ...r, repositoryNames: r.repositoryIds ? r.repositoryIds.map((i) => byId.get(i) ?? "deleted repository").sort() : null }));
}

export function serviceAccountJson(r: ServiceAccountRow) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    permission: r.permission,
    tokenPrefix: r.tokenPrefix,
    repositories: r.repositoryNames,
    createdAt: iso(r.createdAt),
    expiresAt: iso(r.expiresAt),
    lastUsedAt: iso(r.lastUsedAt),
    lastUsedIp: r.lastUsedIp,
  };
}

/** `expiresInDays` (number) or `expiresAt` (ISO date) under the instance policy; neither = never, when allowed. */
export async function expiryFromBody(body: Record<string, unknown>): Promise<Date | null> {
  const { access } = await getInstanceSettings();
  const policy = { maxTokenLifetimeDays: access.maxTokenLifetimeDays, requireTokenExpiry: access.requireTokenExpiry };
  let choice = "never";
  let custom = "";
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    if (typeof body.expiresInDays !== "number" || !Number.isInteger(body.expiresInDays) || body.expiresInDays <= 0) throw unprocessable('"expiresInDays" must be a positive whole number.', { field: "expiresInDays" });
    choice = String(body.expiresInDays);
  } else if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== "string") throw unprocessable('"expiresAt" must be an ISO date.', { field: "expiresAt" });
    choice = "custom";
    custom = body.expiresAt;
  }
  const res = resolveExpiry(choice, custom, policy);
  if ("error" in res) throw unprocessable(res.error, { field: choice === "custom" ? "expiresAt" : "expiresInDays" });
  return res.expiresAt;
}
