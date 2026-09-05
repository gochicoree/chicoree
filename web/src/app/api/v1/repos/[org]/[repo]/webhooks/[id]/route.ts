// GET / PATCH / DELETE /api/v1/repos/{org}/{repo}/webhooks/{id} — one of a repository's webhooks.
import { webhookHandlers } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const h = webhookHandlers("repository");
export const GET = h.get;
export const PATCH = h.update;
export const DELETE = h.remove;
