"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MonitorSmartphone, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/toast";

export interface SessionRow {
  token: string;
  current: boolean;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
}

export function ProfileDetailsForm({
  name: initialName,
  email,
  emailVerified,
}: {
  name: string;
  email: string;
  emailVerified: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <Field label="Email" htmlFor="email">
            <div className="flex items-center gap-2">
              <Input id="email" value={email} disabled />
              <Badge tone={emailVerified ? "ok" : "neutral"}>{emailVerified ? "verified" : "unverified"}</Badge>
            </div>
          </Field>
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
        description="Docker logins use access tokens, so changing this never breaks CI."
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

  async function revoke(token: string) {
    await authClient.revokeSession({ token });
    toast({ title: "Session revoked" });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader eyebrow="Sessions" title="Active sessions" />
      <div>
        {sessions.map((s) => (
          <div key={s.token} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
            <MonitorSmartphone className="size-4 shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{s.userAgent}</div>
              <div className="text-xs text-ink-3">
                {s.ipAddress && `${s.ipAddress} · `}
                started {relativeTime(s.createdAt)}
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
