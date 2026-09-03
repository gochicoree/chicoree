import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getSession } from "@/lib/session";
import { findPendingInvitation } from "@/lib/signup-policy";
import { AcceptInvitation } from "./accept-invitation";

export const metadata: Metadata = { title: "Organization invitation" };

export default async function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, invitation, settings] = await Promise.all([getSession(), findPendingInvitation(id), getInstanceSettings()]);
  return (
    <AcceptInvitation
      id={id}
      signedInAs={session?.user.email ?? null}
      invitation={invitation ? { email: invitation.email, organizationName: invitation.organizationName, role: invitation.role } : null}
      canSignUp={settings.access.signUpMode !== "closed"}
    />
  );
}
