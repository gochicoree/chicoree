"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

export function AcceptInvitation({
  id,
  signedInAs,
  invitation,
  canSignUp,
}: {
  id: string;
  signedInAs: string | null;
  /** null when the invitation is unknown, used or expired. */
  invitation: { email: string; organizationName: string; role: string | null } | null;
  /** false when the instance is closed to new accounts. */
  canSignUp: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = `/accept-invitation/${id}`;
  const mismatch = !!signedInAs && !!invitation && signedInAs.toLowerCase() !== invitation.email.toLowerCase();

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not accept the invitation");
    else router.push("/dashboard");
  }

  async function decline() {
    setBusy(true);
    await authClient.organization.rejectInvitation({ invitationId: id });
    router.push("/dashboard");
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Organization invitation</h1>
          <p className="text-sm text-ink-2">
            {invitation
              ? `You've been invited to join ${invitation.organizationName}${invitation.role ? ` as ${invitation.role}` : ""}.`
              : "This invitation is no longer valid — it may have been used, cancelled or has expired."}
          </p>
        </div>

        {invitation && !signedInAs && (
          <>
            <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent-ink">
              Sign in with <strong>{invitation.email}</strong>{canSignUp ? ", or create an account for that address," : ""} to accept.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href={`/sign-in?invitation=${encodeURIComponent(id)}&next=${encodeURIComponent(here)}`}
                className={buttonClasses("primary", "md", "flex-1")}
              >
                Sign in
              </Link>
              {canSignUp && (
                <Link href={`/sign-up?invitation=${encodeURIComponent(id)}`} className={buttonClasses("secondary", "md", "flex-1")}>
                  Create an account
                </Link>
              )}
            </div>
          </>
        )}

        {invitation && signedInAs && (
          <>
            {mismatch && (
              <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent-ink">
                You are signed in as {signedInAs}, but the invitation was sent to {invitation.email}.
              </p>
            )}
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={accept} disabled={busy} className="flex-1">
                Accept invitation
              </Button>
              <Button variant="secondary" onClick={decline} disabled={busy}>
                Decline
              </Button>
            </div>
          </>
        )}

        {!invitation && (
          <Link href={signedInAs ? "/dashboard" : "/sign-in"} className={buttonClasses("secondary", "md", "w-full")}>
            {signedInAs ? "Go to dashboard" : "Sign in"}
          </Link>
        )}
      </CardBody>
    </Card>
  );
}
