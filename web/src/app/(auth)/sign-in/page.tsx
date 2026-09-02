import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getSession } from "@/lib/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSession()) redirect("/dashboard");
  return (
    <SignInForm
      providers={{
        github: !!env.githubClientId,
        google: !!env.googleClientId,
        oidc: !!env.oidcIssuer,
        oidcName: env.oidcName,
        ldap: env.ldapEnabled,
        ldapName: env.ldapName,
      }}
    />
  );
}
