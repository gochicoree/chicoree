// GET / PATCH / DELETE /api/v1/orgs/{org}/webhooks/{id} — one of the organization's webhooks.
import { webhookHandlers } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const h = webhookHandlers("organization");
export const GET = h.get;
export const PATCH = h.update;
export const DELETE = h.remove;
