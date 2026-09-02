"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

export default function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: session, isPending } = authClient.useSession();

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
            You've been invited to join an organization on this registry.
          </p>
        </div>
        {!isPending && !session && (
          <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent-ink">
            Sign in (or create an account) with the invited email address first, then reopen the
            invitation link.
          </p>
        )}
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={accept} disabled={busy || !session} className="flex-1">
            Accept invitation
          </Button>
          <Button variant="secondary" onClick={decline} disabled={busy || !session}>
            Decline
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
