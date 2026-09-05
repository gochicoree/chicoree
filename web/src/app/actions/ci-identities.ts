"use server";

// Organization → Service accounts → CI identities: trust an OIDC identity
// (a GitHub Actions or GitLab workflow) for keyless authentication, or stop
// trusting it. Owners and admins only.
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ciIdentitiesTrusted, organization, repositories } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { validateCiIdentity } from "@/lib/ci-auth";
import { getOrgRole, requireSession } from "@/lib/session";

export interface CiIdentityResult {
  error?: string;
  saved?: boolean;
}

async function requireManager(organizationId: string): Promise<string | null> {
  await requireSession();
  const role = await getOrgRole(organizationId);
  return role === "owner" || role === "admin" ? null : "Only organization owners and admins can manage CI identities.";
}

export async function addCiIdentity(_prev: CiIdentityResult | null, formData: FormData): Promise<CiIdentityResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const denied = await requireManager(organizationId);
  if (denied) return { error: denied };
  let values;
  try {
    values = validateCiIdentity({
      name: String(formData.get("name") ?? ""),
      issuer: String(formData.get("issuer") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      permission: String(formData.get("permission") ?? "push"),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid identity." };
  }
  const names = String(formData.get("repositories") ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let repositoryIds: string[] | null = null;
  if (names.length) {
    const rows = await db.query.repositories.findMany({ where: and(eq(repositories.organizationId, organizationId), inArray(repositories.name, names)), columns: { id: true, name: true } });
    const missing = names.filter((n) => !rows.some((r) => r.name === n));
    if (missing.length) return { error: `Unknown repositories: ${missing.join(", ")}.` };
    repositoryIds = rows.map((r) => r.id);
  }
  const session = await requireSession();
  const [created] = await db.insert(ciIdentitiesTrusted).values({ organizationId, ...values, repositoryIds, createdBy: session.user.id }).returning({ id: ciIdentitiesTrusted.id });
  await recordAudit({ action: "ci.identity.add", organizationId, targetType: "ci_identity", targetId: created.id, targetLabel: values.name, details: { issuer: values.issuer, subject: values.subject, permission: values.permission, repositories: repositoryIds?.length ?? null } });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
  return { saved: true };
}

export async function removeCiIdentity(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const row = await db.query.ciIdentitiesTrusted.findFirst({ where: eq(ciIdentitiesTrusted.id, id) });
  if (!row) return;
  const denied = await requireManager(row.organizationId);
  if (denied) return;
  await db.delete(ciIdentitiesTrusted).where(eq(ciIdentitiesTrusted.id, id));
  await recordAudit({ action: "ci.identity.remove", organizationId: row.organizationId, targetType: "ci_identity", targetId: row.id, targetLabel: row.name, details: { issuer: row.issuer, subject: row.subject } });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, row.organizationId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
}
