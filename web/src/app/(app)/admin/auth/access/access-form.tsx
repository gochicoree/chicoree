"use client";

import { useActionState, useState } from "react";
import { saveAccessSettings } from "@/app/actions/admin-platform";
import type { SettingsResult } from "@/app/actions/instance-settings";
import type { AccessSettings } from "@/lib/access-shared";
import { LOCAL_SIGNIN_MODES, MIRRORING_MODES, mirroringMode, SIGN_UP_MODES } from "@/lib/access-shared";
import type { SettingsSource } from "@/lib/instance-settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Check, Feedback, HeaderAction, useResultToast } from "../forms";

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

export function AccessForm({ access, source, appUrl }: { access: AccessSettings; source: SettingsSource; appUrl: string }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveAccessSettings, null);
  useResultToast(state);
  const [localMode, setLocalMode] = useState(access.localSignIn);
  const [localPath, setLocalPath] = useState(access.localSignInPath);

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
            <legend className="mb-2 text-[13px] font-medium text-ink">Local sign-in (password, magic link, email code)</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {LOCAL_SIGNIN_MODES.map((m) => (
                <label
                  key={m.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 hover:bg-card-2 has-checked:border-action has-checked:bg-card-2"
                >
                  <input
                    type="radio"
                    name="localSignIn"
                    value={m.value}
                    checked={localMode === m.value}
                    onChange={() => setLocalMode(m.value)}
                    className="mt-1 size-4 accent-[var(--action)]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">{m.label}</span>
                    <span className="block text-xs text-ink-2">{m.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {localMode === "hidden" && (
              <div className="mt-3 sm:max-w-md">
                <Field
                  label="Hidden page"
                  htmlFor="localSignInPath"
                  hint={`${appUrl}/sign-in/${localPath || "local"} — share it only with the people who need a local account. Letters, digits and dashes.`}
                >
                  <Input
                    id="localSignInPath"
                    name="localSignInPath"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    className="font-mono"
                    placeholder="local"
                    maxLength={64}
                  />
                </Field>
              </div>
            )}
            {localMode === "off" && (
              <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
                Make sure at least one administrator can sign in through a provider or a passkey before turning local sign-in off, and note that docker login with a password stops working too (access tokens keep working).
              </p>
            )}
          </fieldset>

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

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">Access tokens and service accounts</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Longest lifetime (days)"
                htmlFor="access-max-token-days"
                hint="Caps the expiry presets and custom dates offered when a token or service account is created; 0 means unlimited. Existing credentials are not shortened."
              >
                <Input
                  id="access-max-token-days"
                  name="maxTokenLifetimeDays"
                  type="number"
                  min={0}
                  max={3650}
                  step={1}
                  defaultValue={access.maxTokenLifetimeDays}
                  className="font-mono"
                />
              </Field>
              <div className="sm:pt-6">
                <Check
                  name="requireTokenExpiry"
                  label="Every token must expire"
                  defaultChecked={access.requireTokenExpiry}
                  hint="Removes the “Never” option; a request without an expiry date is refused."
                />
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">REST API</legend>
            <Check
              key={String(access.apiEnabled)}
              name="apiEnabled"
              label="REST API switched on"
              defaultChecked={access.apiEnabled}
              hint="Off: every /api/v1 endpoint answers 403 api_disabled and the API page, its menu entry and the OpenAPI document disappear. docker login and the jobs API keep working."
            />
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">Features</legend>
            <div className="space-y-3">
              <div key={`mirroring-${mirroringMode(access)}`}>
                <div className="mb-1.5 text-sm text-ink-2">Mirroring and importing</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {MIRRORING_MODES.map((m) => (
                    <Radio
                      key={m.value}
                      name="mirroring"
                      value={m.value}
                      label={m.label}
                      description={m.description}
                      defaultChecked={mirroringMode(access) === m.value}
                    />
                  ))}
                </div>
              </div>
              <Check
                key={`proxyCaches-${access.proxyCaches}`}
                name="proxyCaches"
                label="Proxy caches"
                defaultChecked={access.proxyCaches}
                hint="Off: no organization can become a pull-through cache; existing caches serve what they hold and fetch nothing new."
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
