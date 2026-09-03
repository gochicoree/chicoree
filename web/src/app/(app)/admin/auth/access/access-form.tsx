"use client";

import { useActionState } from "react";
import { saveAccessSettings } from "@/app/actions/admin-platform";
import type { SettingsResult } from "@/app/actions/instance-settings";
import type { AccessSettings } from "@/lib/access-shared";
import { SIGN_UP_MODES } from "@/lib/access-shared";
import type { SettingsSource } from "@/lib/instance-settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { Feedback, HeaderAction, useResultToast } from "../forms";

function Radio({
  name,
  value,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 hover:bg-card-2 has-checked:border-action has-checked:bg-card-2">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} className="mt-1 size-4 accent-[var(--action)]" />
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-ink-2">{description}</span>
      </span>
    </label>
  );
}

export function AccessForm({ access, source }: { access: AccessSettings; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveAccessSettings, null);
  useResultToast(state);

  return (
    <Card>
      <CardHeader
        eyebrow="Registration"
        title="Access"
        description="Who can create an account, which email domains are accepted, and who may create organizations. Existing accounts are never affected; the very first account on an empty instance is always allowed."
        action={<HeaderAction section="access" source={source} />}
      />
      <CardBody>
        <form action={save} className="space-y-6">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">Sign-up</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {SIGN_UP_MODES.map((m) => (
                <Radio
                  key={m.value}
                  name="signUpMode"
                  value={m.value}
                  label={m.label}
                  description={m.description}
                  defaultChecked={access.signUpMode === m.value}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-3">
              Invitation only: the accept-invitation page still lets invitees create an account for the invited address; social, OIDC and directory logins provision accounts only for invited addresses.
            </p>
          </fieldset>

          <Field
            label="Allowed email domains"
            htmlFor="access-domains"
            hint="One per line (or comma-separated). Empty means any domain. Applies to sign-up and to the first login through GitHub, Google, OIDC and LDAP; subdomains are included."
          >
            <Textarea
              id="access-domains"
              name="domains"
              rows={3}
              defaultValue={access.allowedEmailDomains.join("\n")}
              placeholder={"example.com\ncorp.example.org"}
              className="font-mono text-[13px]"
            />
          </Field>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">Organization creation</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <Radio
                name="allowOrganizationCreation"
                value="everyone"
                label="Everyone"
                description="Any signed-in user can create organizations (subject to their limits)."
                defaultChecked={access.allowOrganizationCreation === "everyone"}
              />
              <Radio
                name="allowOrganizationCreation"
                value="admins"
                label="Administrators only"
                description="Users see no create button and the API refuses; admins create organizations and add members."
                defaultChecked={access.allowOrganizationCreation === "admins"}
              />
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              Save access settings
            </Button>
            <Feedback state={state} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
