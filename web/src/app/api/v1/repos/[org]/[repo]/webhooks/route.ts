// GET / POST /api/v1/repos/{org}/{repo}/webhooks — a repository's webhooks (owners and admins).
import { webhookHandlers } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

const h = webhookHandlers("repository");
export const GET = h.list;
export const POST = h.create;
