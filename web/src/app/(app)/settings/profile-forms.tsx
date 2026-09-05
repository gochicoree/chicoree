"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MailCheck, MonitorSmartphone, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { formatDate, relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import { resendVerificationEmail } from "@/app/actions/verification";

export interface SessionRow {
  token: string;
  current: boolean;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

export function ProfileDetailsForm({
  name: initialName,
  email,
  emailVerified,
  emailConfigured = true,
}: {
  name: string;
  email: string;
  emailVerified: boolean;
  /** Outgoing mail is set up; without it there is nothing to resend. */
  emailConfigured?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  async function resend() {
    setVerifying(true);
    setVerifyNote(null);
    const res = await resendVerificationEmail();
    setVerifying(false);
    if (res.error) setVerifyNote(res.error);
    else {
      setVerifyNote(null);
      toast({ title: res.message ?? "Verification email sent" });
    }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.updateUser({ name });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not save");
    else toast({ title: "Profile saved" });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader eyebrow="Profile" title="Your details" />
      <CardBody>
        <form onSubmit={saveProfile} className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field
            label="Email"
            htmlFor="email"
            hint={
              !emailVerified && !emailConfigured
                ? "Ask an administrator to verify this address."
                : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input id="email" value={email} disabled className="min-w-0 flex-1" />
              <Badge tone={emailVerified ? "ok" : "neutral"}>{emailVerified ? "verified" : "unverified"}</Badge>
              {!emailVerified && emailConfigured && (
                <Button type="button" variant="ghost" size="sm" disabled={verifying} onClick={resend}>
                  <MailCheck className="size-3.5" /> {verifying ? "Sending…" : "Resend verification"}
                </Button>
              )}
            </div>
          </Field>
          {verifyNote && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">{verifyNote}</p>}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              Save profile
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function PasswordForm() {
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not change the password");
    else {
      toast({ title: "Password changed", description: "Other sessions were signed out." });
      setCurrentPassword("");
      setNewPassword("");
    }
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Password"
        title="Change password"
        description="Access tokens are not affected."
      />
      <CardBody>
        <form onSubmit={changePassword} className="grid gap-4 sm:grid-cols-2">
          <Field label="Current password" htmlFor="current-password">
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="New password" htmlFor="new-password" hint="At least 10 characters.">
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </Field>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">{error}</p>}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function SessionsList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const { toast } = useToast();

  const [busy, setBusy] = useState(false);

  async function revoke(token: string) {
    const res = await authClient.revokeSession({ token });
    if (res.error) toast({ title: "Could not revoke the session", description: res.error.message ?? undefined, tone: "error" });
    else toast({ title: "Session revoked" });
    router.refresh();
  }

  async function revokeOthers() {
    setBusy(true);
    const res = await authClient.revokeOtherSessions();
    setBusy(false);
    if (res.error) toast({ title: res.error.message ?? "Could not sign out other sessions" });
    else toast({ title: "Signed out everywhere else" });
    router.refresh();
  }

  const others = sessions.filter((s) => !s.current).length;

  return (
    <Card>
      <CardHeader
        eyebrow="Sessions"
        title="Active sessions"
        description="Browsers and devices signed in to your account."
        action={
          <Button type="button" variant="secondary" size="sm" disabled={busy || others === 0} onClick={revokeOthers} data-revoke-others>
            Sign out everywhere else{others > 0 ? ` (${others})` : ""}
          </Button>
        }
      />
      <div>
        {sessions.map((s) => (
          <div key={s.token} data-session-row className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
            <MonitorSmartphone className="size-4 shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]" title={s.userAgent}>{s.userAgent}</div>
              <div className="text-xs text-ink-3">
                {s.ipAddress ? <span className="font-mono">{s.ipAddress}</span> : "unknown address"} · started {relativeTime(s.createdAt)} · last active{" "}
                {relativeTime(s.lastActiveAt)} · expires {formatDate(s.expiresAt)}
              </div>
            </div>
            {s.current ? (
              <Badge tone="ok">this device</Badge>
            ) : (
              <button
                onClick={() => revoke(s.token)}
                aria-label="Revoke session"
                className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
