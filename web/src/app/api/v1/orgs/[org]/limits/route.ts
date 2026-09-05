// GET / PATCH / DELETE /api/v1/orgs/{org}/limits — the organization's limits
// row (instance administrators). PATCH keeps omitted fields; DELETE drops
// the row so only owner-level account limits remain.
import { revalidatePath } from "next/cache";
import { loadOrg, requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { mergeOrgLimitsBody, orgLimitsJson } from "@/lib/api/limits";
import { json, readJson } from "@/lib/api/respond";
import { deleteOrgLimits, getOrgLimitsRow, writeOrgLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";

type Params = { org: string };

export const GET = route<Params>(async (_req, { caller, params }) => {
  requireInstanceAdmin(caller, "read limits", { read: true });
  const a = await loadOrg(caller, params.org);
  return json(orgLimitsJson(a.org.slug, await getOrgLimitsRow(a.org.id)));
});

export const PATCH = route<Params>(async (req, { caller, params }) => {
  requireInstanceAdmin(caller, "change limits");
  const a = await loadOrg(caller, params.org);
  const current = await getOrgLimitsRow(a.org.id);
  const next = mergeOrgLimitsBody(await readJson(req), current);
  await writeOrgLimits(a.org.id, next, { updatedBy: caller.kind === "user" ? caller.user.id : null, actor: caller.auditActor, headers: req.headers, via: "api" });
  revalidatePath(`/admin/organizations/${a.org.id}`);
  revalidatePath(`/${a.org.slug}/settings`);
  return json(orgLimitsJson(a.org.slug, await getOrgLimitsRow(a.org.id)));
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  requireInstanceAdmin(caller, "remove limits");
  const a = await loadOrg(caller, params.org);
  const removed = await deleteOrgLimits(a.org.id, { updatedBy: caller.kind === "user" ? caller.user.id : null, actor: caller.auditActor, headers: req.headers, via: "api" });
  revalidatePath(`/admin/organizations/${a.org.id}`);
  return json({ organization: a.org.slug, removed });
});
