"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { manifests, organization, repositories, signingKeysTrusted } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES, WRITER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";
import { refreshRepositoryBlocks } from "@/lib/pull-policy";
import {
  addTrustedKey,
  removeTrustedKey,
  reverifyOrganization,
  reverifyRepository,
  verifyManifestSignatures,
} from "@/lib/signatures";

export interface SigningKeyResult {
  error?: string;
  saved?: boolean;
  /** Re-verify: how many signed artifacts were checked. */
  signed?: number;
}

async function requireManager(organizationId: string) {
  const session = await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) {
    return { error: "Only organization owners and admins can manage trusted signing keys." } as const;
  }
  return { session } as const;
}

async function revalidateOrg(organizationId: string) {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (org) revalidatePath(`/${org.slug}`, "layout");
  return org;
}

/** Trust a public key for an organization (repositoryId empty) or one repository; every signature in scope is re-verified. */
export async function addTrustedKeyAction(_prev: SigningKeyResult | null, formData: FormData): Promise<SigningKeyResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const repositoryId = String(formData.get("repositoryId") ?? "") || null;
  const name = String(formData.get("name") ?? "");
  const pem = String(formData.get("pem") ?? "");
  const ctx = await requireManager(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  let repoLabel: string | null = null;
  if (repositoryId) {
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
    if (!repo || repo.organizationId !== organizationId) return { error: "Repository not found." };
    repoLabel = repo.name;
  }
  let key;
  try {
    key = await addTrustedKey({ organizationId, repositoryId, name, pem, createdBy: ctx.session.user.id });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the key." };
  }
  const org = await revalidateOrg(organizationId);
  await recordAudit({
    action: "signing_key.add",
    organizationId,
    targetType: repositoryId ? "repository" : "organization",
    targetId: repositoryId ?? organizationId,
    targetLabel: repositoryId ? `${org?.slug}/${repoLabel}` : org?.slug,
    details: { name: key.name, fingerprint: key.fingerprint, keyType: key.keyType },
  });
  if (repositoryId) await reverifyRepository(repositoryId);
  else await reverifyOrganization(organizationId);
  return { saved: true };
}

export async function removeTrustedKeyAction(formData: FormData): Promise<SigningKeyResult> {
  const id = String(formData.get("id") ?? "");
  const row = await db.query.signingKeysTrusted.findFirst({ where: eq(signingKeysTrusted.id, id) });
  if (!row) return { error: "Key not found." };
  const ctx = await requireManager(row.organizationId);
  if ("error" in ctx) return { error: ctx.error };
  await removeTrustedKey(id);
  const org = await revalidateOrg(row.organizationId);
  await recordAudit({
    action: "signing_key.remove",
    organizationId: row.organizationId,
    targetType: row.repositoryId ? "repository" : "organization",
    targetId: row.repositoryId ?? row.organizationId,
    targetLabel: org?.slug,
    details: { name: row.name, fingerprint: row.fingerprint },
  });
  if (row.repositoryId) await reverifyRepository(row.repositoryId);
  else await reverifyOrganization(row.organizationId);
  return { saved: true };
}

/** Re-check the signatures of one image (and, for an index, of its variants) against the trusted keys. */
export async function reverifyManifestAction(formData: FormData): Promise<SigningKeyResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const digest = String(formData.get("digest") ?? "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return { error: "Invalid digest." };
  await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !WRITER_ROLES.includes(role)) return { error: "Only organization members can re-verify signatures." };
  const row = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { payload: true },
  });
  if (!row) return { error: "This image does not exist (anymore)." };
  const subjects = [digest];
  try {
    const parsed = JSON.parse(row.payload) as { manifests?: { digest?: string }[] };
    for (const c of parsed.manifests ?? []) if (c.digest) subjects.push(c.digest);
  } catch {
    // not an index
  }
  let signed = 0;
  for (const s of subjects) signed += await verifyManifestSignatures(repo, s);
  await refreshRepositoryBlocks(repo.id);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  await recordAudit({
    action: "signature.reverify",
    organizationId: repo.organizationId,
    targetType: "manifest",
    targetId: digest,
    targetLabel: `${org?.slug}/${repo.name}@${digest.slice(0, 19)}`,
    details: { subjects: subjects.length, signed },
  });
  if (org) revalidatePath(`/${org.slug}/${repo.name}`, "layout");
  return { saved: true, signed };
}
