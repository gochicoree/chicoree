"use client";

import { useActionState, useState } from "react";
import { Fingerprint, KeyRound, Mail, ShieldOff, Trash2 } from "lucide-react";
import {
  adminDeleteUser,
  adminDisableTwoFactor,
  adminRemovePasskeys,
  adminSendPasswordReset,
  adminSetPassword,
  adminUpdateAccount,
  type AdminUserResult,
} from "@/app/actions/admin-users";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { CopyButton } from "@/components/ui/copy";
import { ConfirmModal } from "@/components/ui/modal";
import { useActionToast } from "@/components/ui/toast";

interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  passkeys: number;
  createdAt: string;
  isSelf: boolean;
}

function ErrorLine({ state }: { state: AdminUserResult | null }) {
  return state?.error ? <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p> : null;
}

function SecretOnce({ secret, label }: { secret: string; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-card-2 p-3 text-sm">
      <p className="mb-1 text-ink-2">{label} It is shown once.</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-ink">{secret}</code>
        <CopyButton value={secret} label="Copy password" />
      </div>
    </div>
  );
}

function DetailsForm({ user }: { user: AccountUser }) {
  const [state, action, pending] = useActionState<AdminUserResult | null, FormData>(adminUpdateAccount, null);
  useActionToast(state, "Account updated");
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={user.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="acct-name">
          <Input id="acct-name" name="name" defaultValue={user.name} required maxLength={120} />
        </Field>
        <Field label="Email" htmlFor="acct-email" hint="Changing it does not send a verification email; tick the box if the new address is known to be good.">
          <Input id="acct-email" name="email" type="email" defaultValue={user.email} required />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" name="emailVerified" defaultChecked={user.emailVerified} className="size-4 accent-[var(--action)]" />
        Email address verified
      </label>
      <ErrorLine state={state} />
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save details"}
        </Button>
      </div>
    </form>
  );
}

function PasswordForm({ user }: { user: AccountUser }) {
  const [state, action, pending] = useActionState<AdminUserResult | null, FormData>(adminSetPassword, null);
  const [reset, resetAction, resetting] = useActionState<AdminUserResult | null, FormData>(adminSendPasswordReset, null);
  useActionToast(state, "Password set");
  useActionToast(reset, "Reset link sent");
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="userId" value={user.id} />
        <div className="sm:max-w-md">
          <Field label="New password" htmlFor="acct-password" hint="Leave empty to generate one. 8 to 128 characters.">
            <Input id="acct-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} className="font-mono" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" name="revokeSessions" defaultChecked className="size-4 accent-[var(--action)]" />
          Sign the user out everywhere
        </label>
        {state?.secret && <SecretOnce secret={state.secret} label="Generated password." />}
        <ErrorLine state={state} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="secondary" disabled={pending}>
            <KeyRound className="size-4" /> {pending ? "Setting…" : "Set password"}
          </Button>
        </div>
      </form>
      <form action={resetAction} className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <input type="hidden" name="userId" value={user.id} />
        <Button type="submit" variant="ghost" size="sm" disabled={resetting}>
          <Mail className="size-4" /> {resetting ? "Sending…" : "Email a reset link instead"}
        </Button>
        <span className="text-xs text-ink-3">Uses the normal forgot-password flow; needs outgoing email.</span>
        <ErrorLine state={reset} />
      </form>
    </div>
  );
}

function SecurityControls({ user }: { user: AccountUser }) {
  const [tfa, tfaAction, tfaPending] = useActionState<AdminUserResult | null, FormData>(adminDisableTwoFactor, null);
  const [pk, pkAction, pkPending] = useActionState<AdminUserResult | null, FormData>(adminRemovePasskeys, null);
  useActionToast(tfa, "Two-factor removed");
  useActionToast(pk, "Passkeys removed");
  const [confirm, setConfirm] = useState<"2fa" | "passkeys" | null>(null);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-xl border border-line bg-card-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Two-factor authentication</span>
          <Badge tone={user.twoFactorEnabled ? "ok" : "neutral"}>{user.twoFactorEnabled ? "enabled" : "off"}</Badge>
        </div>
        <p className="mt-1 text-xs text-ink-2">Removing it deletes the authenticator secret and backup codes; the user can enrol again under Settings → Security.</p>
        <form id="acct-2fa" action={tfaAction}>
          <input type="hidden" name="userId" value={user.id} />
        </form>
        <div className="mt-3">
          <Button type="button" variant="danger" size="sm" disabled={!user.twoFactorEnabled || tfaPending} onClick={() => setConfirm("2fa")}>
            <ShieldOff className="size-3.5" /> Remove two-factor
          </Button>
        </div>
        <ErrorLine state={tfa} />
      </div>
      <div className="rounded-xl border border-line bg-card-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Passkeys</span>
          <Badge tone={user.passkeys > 0 ? "ok" : "neutral"}>{user.passkeys}</Badge>
        </div>
        <p className="mt-1 text-xs text-ink-2">Deleting them means the user signs in with a password, magic link or code until they register a new passkey.</p>
        <form id="acct-passkeys" action={pkAction}>
          <input type="hidden" name="userId" value={user.id} />
        </form>
        <div className="mt-3">
          <Button type="button" variant="danger" size="sm" disabled={user.passkeys === 0 || pkPending} onClick={() => setConfirm("passkeys")}>
            <Fingerprint className="size-3.5" /> Remove all passkeys
          </Button>
        </div>
        <ErrorLine state={pk} />
      </div>
      <ConfirmModal
        open={confirm === "2fa"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          (document.getElementById("acct-2fa") as HTMLFormElement | null)?.requestSubmit();
        }}
        title="Remove two-factor authentication?"
        description={`${user.email} will be able to sign in with just their password. Do this only after checking who is asking.`}
        confirmLabel="Remove two-factor"
        tone="danger"
        busy={tfaPending}
      />
      <ConfirmModal
        open={confirm === "passkeys"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          (document.getElementById("acct-passkeys") as HTMLFormElement | null)?.requestSubmit();
        }}
        title="Remove every passkey?"
        description={`All ${user.passkeys} passkey${user.passkeys === 1 ? "" : "s"} of ${user.email} will be deleted.`}
        confirmLabel="Remove passkeys"
        tone="danger"
        busy={pkPending}
      />
    </div>
  );
}

function DeleteForm({ user }: { user: AccountUser }) {
  const [state, action, pending] = useActionState<AdminUserResult | null, FormData>(adminDeleteUser, null);
  const [typed, setTyped] = useState("");
  const ready = typed.trim().toLowerCase() === user.email.toLowerCase();
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={user.id} />
      <div className="sm:max-w-md">
        <Field label={`Type ${user.email} to confirm`} htmlFor="acct-delete-confirm">
          <Input id="acct-delete-confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
        </Field>
      </div>
      <ErrorLine state={state} />
      <div>
        <Button type="submit" variant="danger" disabled={!ready || pending}>
          <Trash2 className="size-4" /> {pending ? "Deleting…" : "Delete user permanently"}
        </Button>
      </div>
    </form>
  );
}

/** Account administration: details, password, second factors and deletion. */
export function AccountControls({ user }: { user: AccountUser }) {
  if (user.isSelf) return null;
  return (
    <>
      <Card>
        <CardHeader eyebrow="Account" title="Details" description="Name, email address and whether the address counts as verified." />
        <CardBody>
          <DetailsForm user={user} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader eyebrow="Account" title="Password" description="Set a password directly or send the user a reset link." />
        <CardBody>
          <PasswordForm user={user} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader eyebrow="Account" title="Second factors" description="For users who lost their authenticator or device." />
        <CardBody>
          <SecurityControls user={user} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          eyebrow="Danger"
          title="Delete this user"
          description="Removes the account, its sessions, access tokens, passkeys and organization memberships. Repositories stay with their organizations. Refused while the user is the only owner of an organization."
        />
        <CardBody>
          <DeleteForm user={user} />
        </CardBody>
      </Card>
    </>
  );
}
