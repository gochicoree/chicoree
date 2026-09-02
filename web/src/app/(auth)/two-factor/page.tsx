"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";

type Method = "totp" | "email" | "backup";

// Second step of sign-in for accounts with 2FA enabled.
export default function TwoFactorPage() {
  const router = useRouter();
  const [method, setMethod] = useState<Method>("totp");
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const opts = { code, trustDevice: trust };
    const res =
      method === "totp"
        ? await authClient.twoFactor.verifyTotp(opts)
        : method === "email"
          ? await authClient.twoFactor.verifyOtp(opts)
          : await authClient.twoFactor.verifyBackupCode({ code });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Verification failed");
    else router.push("/dashboard");
  }

  async function sendEmailCode() {
    setMethod("email");
    setError(null);
    const { error } = await authClient.twoFactor.sendOtp();
    if (error) setError(error.message ?? "Could not send the code");
    else setNotice("Code sent — check your inbox.");
  }

  return (
    <Card>
      <CardBody className="space-y-4 py-5">
        <div>
          <h1 className="font-display text-lg font-semibold">Two-factor verification</h1>
          <p className="text-sm text-ink-2">
            {method === "totp" && "Enter the six-digit code from your authenticator app."}
            {method === "email" && "Enter the code we emailed you."}
            {method === "backup" && "Enter one of your backup codes."}
          </p>
        </div>
        <form onSubmit={verify} className="space-y-3">
          <Field label={method === "backup" ? "Backup code" : "Code"} htmlFor="code">
            <Input
              id="code"
              required
              autoFocus
              inputMode={method === "backup" ? "text" : "numeric"}
              autoComplete="one-time-code"
              className="text-center font-mono text-lg tracking-[0.3em]"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          {method !== "backup" && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={trust}
                onChange={(e) => setTrust(e.target.checked)}
                className="size-4 accent-[var(--action)]"
              />
              Trust this device for 60 days
            </label>
          )}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {notice && <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">{notice}</p>}
          <Button type="submit" disabled={busy || code.length < 6} className="w-full">
            Verify
          </Button>
        </form>
        <div className="space-y-1 text-center text-sm">
          {method !== "email" && (
            <button onClick={sendEmailCode} className="block w-full text-ink-2 hover:text-ink cursor-pointer">
              Email me a code instead
            </button>
          )}
          {method !== "totp" && (
            <button
              onClick={() => {
                setMethod("totp");
                setNotice(null);
              }}
              className="block w-full text-ink-2 hover:text-ink cursor-pointer"
            >
              Use my authenticator app
            </button>
          )}
          {method !== "backup" && (
            <button
              onClick={() => {
                setMethod("backup");
                setNotice(null);
              }}
              className="block w-full text-ink-2 hover:text-ink cursor-pointer"
            >
              Use a backup code
            </button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
