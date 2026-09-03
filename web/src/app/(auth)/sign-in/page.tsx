import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getSession } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSession()) redirect("/dashboard");
  const s = await getInstanceSettings();
  return (
    <SignInForm
      providers={{
        github: s.github.enabled && !!s.github.clientId,
        google: s.google.enabled && !!s.google.clientId,
        oidc: s.oidc.enabled && !!s.oidc.issuer,
        oidcName: s.oidc.name,
        ldap: s.ldap.enabled && !!s.ldap.url,
        ldapName: s.ldap.name,
      }}
    />
  );
}
