// GET /api/v1/openapi.json — the OpenAPI 3.1 document of this instance.
import { route } from "@/lib/api/handler";
import { openApiDocument } from "@/lib/api/openapi";
import { json } from "@/lib/api/respond";
import { getBranding } from "@/lib/branding";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const branding = await getBranding();
  return json(openApiDocument({ appUrl: env.appUrl, instanceName: branding.instanceName }), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
});
