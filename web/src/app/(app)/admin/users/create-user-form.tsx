"use client";

import { useActionState } from "react";
import { UserPlus } from "lucide-react";
import { adminCreateUser, type AdminUserResult } from "@/app/actions/admin-users";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { CopyButton } from "@/components/ui/copy";
import { useActionToast } from "@/components/ui/toast";

/** Creates an account from the admin panel, regardless of the sign-up mode. */
export function CreateUserForm() {
  const [state, action, pending] = useActionState<AdminUserResult | null, FormData>(adminCreateUser, null);
  useActionToast(state, "User created");
  return (
    <Card>
      <CardHeader eyebrow="People" title="Create a user" description="Works even when sign-up is closed. Leave the password empty to generate one you can hand over." />
      <CardBody>
        <form action={action} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name" htmlFor="new-user-name">
              <Input id="new-user-name" name="name" required maxLength={120} placeholder="Jane Doe" />
            </Field>
            <Field label="Email" htmlFor="new-user-email">
              <Input id="new-user-email" name="email" type="email" required placeholder="jane@example.com" />
            </Field>
            <Field label="Password" htmlFor="new-user-password" hint="Empty = generated, shown once.">
              <Input id="new-user-password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} className="font-mono" />
            </Field>
            <Field label="Role" htmlFor="new-user-role">
              <Select
                id="new-user-role"
                name="role"
                defaultValue="user"
                options={[
                  { value: "user", label: "user", description: "Regular account" },
                  { value: "admin", label: "admin", description: "Instance administrator" },
                ]}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="emailVerified" defaultChecked className="size-4 accent-[var(--action)]" />
            Mark the email address as verified
          </label>
          {state?.secret && (
            <div className="rounded-lg border border-line bg-card-2 p-3 text-sm">
              <p className="mb-1 text-ink-2">Generated password for the new account. It is shown once.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-ink">{state.secret}</code>
                <CopyButton value={state.secret} label="Copy password" />
              </div>
            </div>
          )}
          {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
          <div>
            <Button type="submit" variant="secondary" disabled={pending}>
              <UserPlus className="size-4" /> {pending ? "Creating…" : "Create user"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
