// GET / PATCH / DELETE /api/v1/users/{userId}/limits — the account's limits
// row (instance administrators). Account limits apply to everything the
// user owns, summed across their organizations.
import { revalidatePath } from "next/cache";
import { requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { mergeUserLimitsBody, userLimitsJson } from "@/lib/api/limits";
import { json, readJson } from "@/lib/api/respond";
import { userDetail } from "@/lib/api/users";
import { deleteUserLimits, getUserLimitsRow, writeUserLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";

type Params = { userId: string };

export const GET = route<Params>(async (_req, { caller, params }) => {
  requireInstanceAdmin(caller, "read limits", { read: true });
  const u = await userDetail(params.userId);
  return json(userLimitsJson(u.id, await getUserLimitsRow(u.id)));
});

export const PATCH = route<Params>(async (req, { caller, params }) => {
  requireInstanceAdmin(caller, "change limits");
  const u = await userDetail(params.userId);
  const next = mergeUserLimitsBody(await readJson(req), await getUserLimitsRow(u.id));
  await writeUserLimits(u.id, next, { updatedBy: caller.kind === "user" ? caller.user.id : null, actor: caller.auditActor, headers: req.headers, via: "api" });
  revalidatePath(`/admin/users/${u.id}`);
  revalidatePath("/settings");
  return json(userLimitsJson(u.id, await getUserLimitsRow(u.id)));
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  requireInstanceAdmin(caller, "remove limits");
  const u = await userDetail(params.userId);
  const removed = await deleteUserLimits(u.id, { updatedBy: caller.kind === "user" ? caller.user.id : null, actor: caller.auditActor, headers: req.headers, via: "api" });
  revalidatePath(`/admin/users/${u.id}`);
  return json({ user: u.id, removed });
});
