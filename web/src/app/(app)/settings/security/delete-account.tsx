"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";

/**
 * Self-service account deletion. With outgoing mail the request is
 * confirmed from the inbox; otherwise the password (or, for accounts
 * without one, a fresh sign-in) confirms it. The server refuses when the
 * account is the only owner of an organization or the last administrator.
 */
export function DeleteAccount({ byEmail, hasPassword, fresh }: { byEmail: boolean; hasPassword: boolean; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, start] = useTransition();
  const router = useRouter();
  const needsPassword = !byEmail && hasPassword;
  const blocked = !byEmail && !hasPassword && !fresh;

  function confirm() {
    setError(null);
    start(async () => {
      const res = await authClient.deleteUser(
        byEmail ? { callbackURL: "/sign-in?deleted=1" } : needsPassword ? { password, callbackURL: "/sign-in?deleted=1" } : { callbackURL: "/sign-in?deleted=1" },
      );
      if (res.error) {
        setError(res.error.message ?? "The account could not be deleted.");
        return;
      }
      if (byEmail) {
        setSent(true);
        return;
      }
      router.push("/sign-in?deleted=1");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Danger zone"
        title="Delete account"
        description="Removes your account with its access tokens, signing keys and memberships. This cannot be undone."
      />
      <CardBody>
        <Button type="button" variant="danger" onClick={() => setOpen(true)}>
          <Trash2 className="size-4" /> Delete my account
        </Button>
      </CardBody>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete your account?"
        description={
          byEmail
            ? "We will email you a confirmation link. Nothing happens until you open it."
            : needsPassword
              ? "Enter your password to confirm."
              : blocked
                ? "Sign in again first, then come back here."
                : "This deletes the account right away."
        }
      >
        {sent ? (
          <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">Check your inbox for the confirmation link.</p>
        ) : (
          <div className="space-y-3">
            {needsPassword && (
              <Field label="Password" htmlFor="delete-password">
                <Input id="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="danger" disabled={busy || blocked || (needsPassword && !password)} onClick={confirm}>
                {busy ? "Working…" : byEmail ? "Send confirmation email" : "Delete account"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
