"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/toast";

interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string | null;
  deviceType: string;
}

export function PasskeyManager({
  passkeys,
  fresh = true,
}: {
  passkeys: PasskeyRow[];
  /** Registering a passkey needs a session younger than better-auth's freshAge (a day by default). */
  fresh?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.passkey.addPasskey({ name: name || undefined });
    setBusy(false);
    if (res?.error) {
      setError(
        "code" in res.error && res.error.code === "SESSION_NOT_FRESH"
          ? "Adding a passkey needs a recent sign-in. Sign out and back in, then try again."
          : (res.error.message ?? "Could not register the passkey"),
      );
    }
    else {
      toast({ title: "Passkey added" });
      setName("");
      router.refresh();
    }
  }

  async function remove(id: string) {
    await authClient.passkey.deletePasskey({ id });
    toast({ title: "Passkey removed" });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Passkeys"
        title="Passkeys"
        description="Sign in with your device's screen lock or a hardware key — no password involved."
      />
      <CardBody className="space-y-4">
        <form onSubmit={add} className="flex gap-2">
          <Input
            placeholder="Name this device (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            <Fingerprint className="size-4" /> Add passkey
          </Button>
        </form>
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        {!fresh && !error && (
          <p className="text-xs text-ink-3">You signed in more than a day ago; adding a passkey asks for a fresh sign-in first.</p>
        )}

        {passkeys.length === 0 ? (
          <p className="text-sm text-ink-3">No passkeys registered yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <Fingerprint className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-ink-3">
                    {p.deviceType === "multiDevice" ? "synced" : "device-bound"}
                    {p.createdAt && ` · added ${relativeTime(p.createdAt)}`}
                  </div>
                </div>
                <button
                  onClick={() => remove(p.id)}
                  aria-label={`Remove ${p.name}`}
                  className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
