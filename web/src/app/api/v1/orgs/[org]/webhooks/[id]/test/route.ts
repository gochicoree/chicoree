// POST /api/v1/orgs/{org}/webhooks/{id}/test — send a test delivery.
import { webhookHandlers } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

export const POST = webhookHandlers("organization").test;
