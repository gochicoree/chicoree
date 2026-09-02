"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

function EmailOtpInner() {
  const router = useRouter();
  const email = useSearchParams().get("email") ?? "";
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp });
    setBusy(false);
    if (error) setError(error.message ?? "That code didn't work");
    else router.push("/dashboard");
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Enter your code</h1>
          <p className="text-sm text-ink-2">We sent a one-time code to {email || "your email"}.</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Code" htmlFor="otp">
            <Input
              id="otp"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-center font-mono text-lg tracking-[0.3em]"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          </Field>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={busy || otp.length < 6} className="w-full">
            Sign in
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export default function EmailOtpPage() {
  return (
    <Suspense>
      <EmailOtpInner />
    </Suspense>
  );
}
