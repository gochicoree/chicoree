import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getSession } from "@/lib/session";
import { domainRestrictionMessage, findPendingInvitation, isFreshInstall, signUpClosedMessage } from "@/lib/signup-policy";
import { Card, CardBody } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await getSession()) redirect("/dashboard");
  const sp = await searchParams;
  const invitationId = typeof sp.invitation === "string" ? sp.invitation.slice(0, 100) : "";
  const [settings, invitation, fresh] = await Promise.all([
    getInstanceSettings(),
    invitationId ? findPendingInvitation(invitationId) : Promise.resolve(null),
    isFreshInstall(),
  ]);
  const { access } = settings;
  const blocked = !fresh && (access.signUpMode === "closed" || (access.signUpMode === "invite" && !invitation));

  if (blocked) {
    return (
      <Card>
        <CardBody className="space-y-4 py-5">
          <div>
            <h1 className="font-display text-lg font-semibold">
              {access.signUpMode === "closed" ? "Sign-up is closed" : "Invitation required"}
            </h1>
            <p className="mt-1 text-sm text-ink-2">
              {invitationId && !invitation
                ? "This invitation is no longer valid. Ask the organization for a new one."
                : signUpClosedMessage(access)}
            </p>
          </div>
          <Link href="/sign-in" className={buttonClasses("primary", "md", "w-full")}>
            Sign in instead
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <SignUpForm
      invitation={
        invitation
          ? { id: invitation.id, email: invitation.email, organizationName: invitation.organizationName }
          : null
      }
      domainHint={domainRestrictionMessage(access)}
      firstAccount={fresh}
    />
  );
}
