import type { Metadata } from "next";
import { env } from "@/lib/env";
import { getInstanceSettings } from "@/lib/instance-settings";
import { OAuthProviderForm } from "../forms";

export const metadata: Metadata = { title: "Sign-in providers" };

export default async function AdminProviderSettings() {
  const s = await getInstanceSettings();
  const base = env.appUrl.replace(/\/$/, "");
  return (
    <div className="space-y-6">
      <OAuthProviderForm
        provider="github"
        title="GitHub"
        callbackUrl={`${base}/api/auth/callback/github`}
        values={{ enabled: s.github.enabled, clientId: s.github.clientId }}
        hasSecret={!!s.github.clientSecret}
        source={s.sources.github}
      />
      <OAuthProviderForm
        provider="google"
        title="Google"
        callbackUrl={`${base}/api/auth/callback/google`}
        values={{ enabled: s.google.enabled, clientId: s.google.clientId }}
        hasSecret={!!s.google.clientSecret}
        source={s.sources.google}
      />
      <OAuthProviderForm
        provider="oidc"
        title="OpenID Connect"
        callbackUrl={`${base}/api/auth/oauth2/callback/oidc`}
        values={{
          enabled: s.oidc.enabled,
          clientId: s.oidc.clientId,
          issuer: s.oidc.issuer,
          name: s.oidc.name,
          scopes: s.oidc.scopes,
          groupsClaim: s.oidc.groupsClaim,
        }}
        hasSecret={!!s.oidc.clientSecret}
        source={s.sources.oidc}
      />
    </div>
  );
}
