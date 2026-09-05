// GET / POST /api/v1/orgs/{org}/webhooks — the organization's webhooks (owners and admins).
import { webhookHandlers } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const h = webhookHandlers("organization");
export const GET = h.list;
export const POST = h.create;
