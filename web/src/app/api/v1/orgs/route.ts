// GET  /api/v1/orgs — organizations the caller belongs to or can see a repository of.
// POST /api/v1/orgs — create one (the caller becomes its owner).
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { member, organization } from "@/db/schema";
import { requireUser } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { listOrgs, orgDetail } from "@/lib/api/queries";
import { conflict, forbidden, json, paged, pageParams, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { loadOrg } from "@/lib/api/access";
import { recordAudit } from "@/lib/audit";
import { RESERVED_SLUGS } from "@/lib/auth";
import { getInstanceSettings } from "@/lib/instance-settings";
import { checkOrgCreationQuota } from "@/lib/quota";
import { clearOrganizationRedirect } from "@/lib/redirects";
import { ORG_SLUG_RE } from "@/lib/repo-names-shared";
import { canCreateOrganization, ORG_CREATION_DENIED } from "@/lib/signup-policy";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { caller, url }) => {
  const { page, pageSize } = pageParams(url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 120);
  const { rows, state } = await listOrgs(caller, { q, page, pageSize });
  return json(paged(rows, state));
});

export const POST = route(async (req, { caller }) => {
  const c = requireUser(caller);
  if (c.caller.patScope === "read") throw forbidden("This access token is read-only; creating organizations needs a read & write token.");
  if (c.caller.restriction) throw forbidden("This access token is limited to one organization; it cannot create organizations.");
  const { access } = await getInstanceSettings();
  if (!canCreateOrganization(access, c.user.role)) throw forbidden(ORG_CREATION_DENIED);
  const body = await readJson(req);
  const slug = (stringField(body, "slug", 64) ?? "").toLowerCase();
  const name = stringField(body, "name", 100) ?? slug;
  if (!ORG_SLUG_RE.test(slug) || slug.length > 64) throw unprocessable("Organization slugs use lowercase letters, digits and single ._- separators (they become the image namespace).", { field: "slug" });
  if (RESERVED_SLUGS.has(slug)) throw unprocessable(`"${slug}" is reserved; pick a different slug.`, { field: "slug" });
  if (!name) throw unprocessable('"name" is required.', { field: "name" });
  if (await db.query.organization.findFirst({ where: eq(organization.slug, slug), columns: { id: true } })) throw conflict(`An organization with the slug ${slug} already exists.`);
  if (!c.caller.isAdmin) {
    const quota = await checkOrgCreationQuota(c.user.id);
    if (quota) throw forbidden(quota);
  }
  const now = new Date();
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(organization).values({ id, slug, name, createdAt: now });
    await tx.insert(member).values({ id: randomUUID(), organizationId: id, userId: c.user.id, role: "owner", createdAt: now });
  });
  // A former slug of a renamed organization can be reused; the redirect ends here.
  await clearOrganizationRedirect(slug);
  await recordAudit({ action: "org.create", actor: caller.auditActor, headers: req.headers, organizationId: id, targetType: "organization", targetId: id, targetLabel: slug, details: { name, via: "api" } });
  revalidatePath("/", "layout");
  return json(await orgDetail(caller, await loadOrg(caller, slug)), { status: 201 });
});
