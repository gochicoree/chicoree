"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { CommandLine } from "@/components/ui/copy";
import { Badge } from "@/components/ui/badge";

export function TwoFactorManager({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Could not enable two-factor auth");
      return;
    }
    if (res.data.method !== "totp") {
      setError("Unexpected enrollment method from the server");
      return;
    }
    setTotpUri(res.data.totpURI);
    setBackupCodes(res.data.backupCodes);
    setQrDataUrl(await QRCode.toDataURL(res.data.totpURI, { margin: 1, width: 220 }));
    setPassword("");
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: verifyCode });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "That code didn't match — try the next one");
      return;
    }
    setQrDataUrl(null);
    setTotpUri(null);
    router.refresh();
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not disable two-factor auth");
    else {
      setPassword("");
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Two-factor"
        title="Two-factor authentication"
        description="A second step at sign-in: a code from your authenticator app, or one emailed to you."
        action={
          enabled ? (
            <Badge tone="ok">
              <ShieldCheck className="size-3" /> enabled
            </Badge>
          ) : (
            <Badge>
              <ShieldOff className="size-3" /> off
            </Badge>
          )
        }
      />
      <CardBody>
        {error && <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        {qrDataUrl && totpUri ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="TOTP enrollment QR code" className="max-w-full rounded-lg border border-line" />
              <div className="min-w-60 flex-1 space-y-3">
                <p className="text-sm text-ink-2">
                  Scan the code with your authenticator app, or add the secret manually:
                </p>
                <CommandLine command={totpUri} />
                <form onSubmit={confirmTotp} className="space-y-3">
                  <Field label="Enter the app's current code to finish" htmlFor="confirm-code">
                    <Input
                      id="confirm-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="max-w-40 text-center font-mono tracking-[0.3em]"
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value)}
                      required
                    />
                  </Field>
                  <Button type="submit" disabled={busy || verifyCode.length < 6}>
                    Confirm and enable
                  </Button>
                </form>
              </div>
            </div>
            {backupCodes.length > 0 && (
              <div className="rounded-lg border border-accent/40 bg-accent-soft p-4">
                <p className="mb-2 text-sm font-medium text-accent-ink">
                  Backup codes — save these somewhere safe. Each works once.
                </p>
                <div className="grid grid-cols-2 gap-1 font-mono text-[13px] sm:grid-cols-5">
                  {backupCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={enabled ? disable : enable} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Field label="Confirm with your password" htmlFor="tf-password">
                <Input
                  id="tf-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
            </div>
            <Button type="submit" variant={enabled ? "danger" : "primary"} disabled={busy}>
              {enabled ? "Disable" : "Enable two-factor"}
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
