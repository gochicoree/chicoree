"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, LogOut, ShieldCheck, UserCog } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

export function UserControls({
  userId,
  name,
  isSelf,
  role,
  banned,
  sessions = 0,
}: {
  userId: string;
  /** Display name, shown in the ban confirmation. */
  name: string;
  isSelf: boolean;
  role: string;
  banned: boolean;
  /** Active sessions; the revoke button is disabled at zero. */
  sessions?: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmBan, setConfirmBan] = useState(false);

  async function run(fn: () => Promise<{ error?: { message?: string } | null }>, done: string) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) setError(res.error.message ?? "That didn't work");
    else toast({ title: done });
    router.refresh();
  }

  async function impersonate() {
    setBusy(true);
    setError(null);
    const res = await authClient.admin.impersonateUser({ userId });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Could not impersonate");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (isSelf) {
    return <p className="text-sm text-ink-3">This is your own account — manage it under Settings.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Role
        <Select
          value={role}
          disabled={busy}
          onChange={(v) => run(() => authClient.admin.setRole({ userId, role: v as "user" | "admin" }), `Role set to ${v}`)}
          className="w-28"
          size="sm"
          aria-label="Role"
          options={[
            { value: "user", label: "user" },
            { value: "admin", label: "admin" },
          ]}
        />
      </label>
      <Button
        type="button"
        variant={banned ? "secondary" : "danger"}
        size="sm"
        disabled={busy}
        onClick={() => (banned ? run(() => authClient.admin.unbanUser({ userId }), "User unbanned") : setConfirmBan(true))}
      >
        {banned ? <ShieldCheck className="size-3.5" /> : <Ban className="size-3.5" />}
        {banned ? "Unban" : "Ban"}
      </Button>
      <Button variant="secondary" size="sm" disabled={busy || banned} onClick={impersonate}>
        <UserCog className="size-3.5" /> Impersonate
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || sessions === 0}
        title="Signs the user out of every browser and device"
        onClick={() => run(() => authClient.admin.revokeUserSessions({ userId }), "All sessions revoked")}
      >
        <LogOut className="size-3.5" /> Revoke all sessions
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
      <ConfirmModal
        open={confirmBan}
        onClose={() => setConfirmBan(false)}
        onConfirm={async () => {
          await run(() => authClient.admin.banUser({ userId, banReason: "Banned by administrator" }), "User banned");
          setConfirmBan(false);
        }}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Banning…" : "Ban user"}
        title={`Ban ${name}?`}
        description="They are signed out everywhere and cannot sign in until unbanned. Their organizations and images stay as they are."
      />
    </div>
  );
}
