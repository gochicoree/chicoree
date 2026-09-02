"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, ShieldCheck, UserCog } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export function UserControls({
  userId,
  isSelf,
  role,
  banned,
}: {
  userId: string;
  isSelf: boolean;
  role: string;
  banned: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) setError(res.error.message ?? "That didn't work");
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
          onChange={(v) => run(() => authClient.admin.setRole({ userId, role: v as "user" | "admin" }))}
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
        variant={banned ? "secondary" : "danger"}
        size="sm"
        disabled={busy}
        onClick={() =>
          run(() =>
            banned
              ? authClient.admin.unbanUser({ userId })
              : authClient.admin.banUser({ userId, banReason: "Banned by administrator" }),
          )
        }
      >
        {banned ? <ShieldCheck className="size-3.5" /> : <Ban className="size-3.5" />}
        {banned ? "Unban" : "Ban"}
      </Button>
      <Button variant="secondary" size="sm" disabled={busy || banned} onClick={impersonate}>
        <UserCog className="size-3.5" /> Impersonate
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
