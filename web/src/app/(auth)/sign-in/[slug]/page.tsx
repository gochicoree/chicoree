import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getSession } from "@/lib/session";
import { SignInForm } from "../sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * The hidden local sign-in page (Administration → Auth providers → Access →
 * Local sign-in = "Hidden URL only"): same form as /sign-in, with password,
 * magic link and email code offered. Any other slug is a normal 404.
 */
export default async function HiddenSignInPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getInstanceSettings();
  if (s.access.localSignIn !== "hidden" || slug !== s.access.localSignInPath) notFound();
  if (await getSession()) redirect("/dashboard");
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
      signUp={{ mode: s.access.signUpMode, invitationId: "" }}
      local={{ mode: "hidden", slug }}
    />
  );
}
