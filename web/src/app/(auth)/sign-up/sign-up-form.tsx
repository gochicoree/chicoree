"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { INVITATION_HEADER } from "@/lib/access-shared";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

export function SignUpForm({
  invitation,
  domainHint,
  firstAccount,
}: {
  /** Set when the visitor arrived through an organization invitation. */
  invitation: { id: string; email: string; organizationName: string } | null;
  /** "Only email addresses at … can register." when domains are restricted. */
  domainHint: string;
  firstAccount: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invitation?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const destination = invitation ? `/accept-invitation/${invitation.id}` : "/dashboard";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signUp.email(
      { name, email, password, callbackURL: destination },
      // The invitation id lets the server match this sign-up to the invitation
      // when the instance is invitation-only.
      invitation ? { headers: { [INVITATION_HEADER]: invitation.id } } : undefined,
    );
    setBusy(false);
    if (error) setError(error.message ?? "Sign-up failed");
    else router.push(destination);
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Create your account</h1>
          <p className="text-sm text-ink-2">
            {invitation
              ? `You've been invited to ${invitation.organizationName}. Create an account for ${invitation.email} to join.`
              : firstAccount
                ? "The first account on a fresh install becomes the administrator."
                : "Choose a name, an email address and a password."}
          </p>
          {domainHint && <p className="mt-1 text-xs text-ink-3">{domainHint}</p>}
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name" htmlFor="name">
            <Input id="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="email" hint={invitation ? "The address the invitation was sent to." : undefined}>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              readOnly={!!invitation}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 10 characters.">
            <Input
              id="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            Create account
          </Button>
        </form>
        <p className="text-center text-sm text-ink-2">
          Already have an account?{" "}
          <Link
            href={invitation ? `/sign-in?invitation=${encodeURIComponent(invitation.id)}&next=${encodeURIComponent(destination)}` : "/sign-in"}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
