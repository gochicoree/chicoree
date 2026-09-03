import { env } from "@/lib/env";
import { getOrgProxy, splitProxyAuth } from "@/lib/proxy";
import { orgSettingsContext } from "../context";
import { ProxyForm } from "./proxy-form";

export default async function OrgProxySettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, library } = await orgSettingsContext(params);
  const proxy = await getOrgProxy(org.id);
  const stored = proxy ? splitProxyAuth(proxy.auth) : null;
  return (
    <ProxyForm
      organizationId={org.id}
      slug={org.slug}
      registryHost={env.registryHost}
      isLibrary={library}
      proxy={
        proxy
          ? {
              upstreamUrl: proxy.upstreamUrl,
              preset: proxy.preset,
              hasAuth: !!proxy.auth,
              username: stored?.username ?? "",
              allowedPatterns: proxy.allowedPatterns,
              tagTtlSeconds: proxy.tagTtlSeconds,
              enabled: proxy.enabled,
              lastCheckedAt: proxy.lastCheckedAt?.toISOString() ?? null,
              lastError: proxy.lastError,
            }
          : null
      }
    />
  );
}
