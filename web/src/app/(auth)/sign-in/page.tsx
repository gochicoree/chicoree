import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getSession } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/** Only same-origin paths may be used as the post-sign-in destination. */
function safeNext(v: string | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : "/dashboard";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : undefined);
  if (await getSession()) redirect(next);
  const s = await getInstanceSettings();
  const invitationId = typeof sp.invitation === "string" ? sp.invitation.slice(0, 100) : "";
  return (
    <SignInForm
      providers={{
        github: s.github.enabled && !!s.github.clientId,
        google: s.google.enabled && !!s.google.clientId,
        oidc: s.oidc.enabled && !!s.oidc.issuer,
        oidcName: s.oidc.name,
        ldap: s.ldap.enabled && !!s.ldap.url,
        ldapName: s.ldap.name,
        email: !!s.smtp.host,
      }}
      signUp={{ mode: s.access.signUpMode, invitationId }}
      local={{ mode: s.access.localSignIn }}
      next={next}
    />
  );
}
