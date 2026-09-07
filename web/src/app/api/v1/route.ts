// GET /api/v1 — the API index: version, revision, changelog, the notice on
// how the API evolves, and the endpoint catalog. Needs no credentials.
import { API_CATALOG } from "@/lib/api/catalog";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { absolute } from "@/lib/api/serialize";
import { API_BASE, API_CHANGELOG, API_NOTICE, API_REVISION, API_VERSION } from "@/lib/api/version";
import { getBranding } from "@/lib/branding";
import { getInstanceSettings } from "@/lib/instance-settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const [branding, settings] = await Promise.all([getBranding(), getInstanceSettings()]);
  return json({
    name: `${branding.instanceName || "Chicorée"} REST API`,
    version: API_VERSION,
    revision: API_REVISION,
    base: absolute(API_BASE),
    docs: absolute("/docs/api"),
    notice: API_NOTICE,
    // Instance-wide switches (Administration → Auth providers → Access → Features).
    features: { mirroring: settings.access.mirroring, proxyCaches: settings.access.proxyCaches },
    changelog: API_CHANGELOG,
    endpoints: API_CATALOG.map((e) => ({
      method: e.method,
      path: `${API_BASE}${e.path === "/" ? "" : e.path}`,
      summary: e.summary,
      access: e.access,
      write: !!e.write,
      serviceAccounts: !!e.serviceAccounts,
      since: e.since,
      ...(e.deprecated ? { deprecated: e.deprecated } : {}),
    })),
  });
});
