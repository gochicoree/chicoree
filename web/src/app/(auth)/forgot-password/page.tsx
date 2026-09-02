"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setBusy(false);
    if (error) setError(error.message ?? "Could not send the reset link");
    else setSent(true);
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Reset your password</h1>
          <p className="text-sm text-ink-2">We'll email you a link to choose a new one.</p>
        </div>
        {sent ? (
          <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
            If an account exists for {email}, a reset link is on its way.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              Send reset link
            </Button>
          </form>
        )}
        <p className="text-center text-sm text-ink-2">
          <Link href="/sign-in" className="font-medium text-ink underline-offset-2 hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
