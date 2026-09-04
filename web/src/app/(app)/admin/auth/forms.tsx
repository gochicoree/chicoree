"use client";

import { useActionState, useEffect, useRef, useTransition, type ReactNode } from "react";
import { Mail, Plug, RotateCcw } from "lucide-react";
import {
  resetSection,
  saveGroupBindings,
  saveLdapSettings,
  saveOAuthProvider,
  saveSmtpSettings,
  sendTestEmail,
  testLdapSettings,
  type SettingsResult,
} from "@/app/actions/instance-settings";
import type { LdapSettings, SettingsSection, SettingsSource, SmtpSettings } from "@/lib/instance-settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FieldAction, Input, Textarea } from "@/components/ui/field";
import { CommandLine } from "@/components/ui/copy";
import { useToast } from "@/components/ui/toast";

// --- shared bits -----------------------------------------------------------

export function useResultToast(state: SettingsResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message });
  }, [state, toast]);
}

function SourceBadge({ source }: { source: SettingsSource }) {
  if (source === "database") return <Badge tone="ok">saved in admin settings</Badge>;
  if (source === "environment") return <Badge tone="info">from environment</Badge>;
  return <Badge>not configured</Badge>;
}

/** Drops the stored section so the environment defaults apply again. */
function ResetButton({ section }: { section: SettingsSection }) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(resetSection, null);
  useResultToast(state);
  return (
    <form action={action}>
      <input type="hidden" name="section" value={section} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <RotateCcw className="size-3.5" /> Use environment values
      </Button>
    </form>
  );
}

export function HeaderAction({ section, source }: { section: SettingsSection; source: SettingsSource }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SourceBadge source={source} />
      {source === "database" && <ResetButton section={section} />}
    </div>
  );
}

const secretHint = (has: boolean) => (has ? "Stored — leave blank to keep, enter - to clear." : undefined);

/** Submit helpers that invoke actions from the form's live values (no React form reset). */
function useFormRunner() {
  const formRef = useRef<HTMLFormElement>(null);
  const [, start] = useTransition();
  function run(act: (payload: FormData) => void) {
    if (!formRef.current) return;
    if (!formRef.current.reportValidity()) return;
    const data = new FormData(formRef.current);
    start(() => act(data));
  }
  return { formRef, run };
}

export function Feedback({ state }: { state: SettingsResult | null }) {
  if (!state?.error) return null;
  return <span className="text-sm text-danger">{state.error}</span>;
}

export function Check({ name, label, defaultChecked, hint }: { name: string; label: string; defaultChecked: boolean; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm text-ink-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 size-4 accent-[var(--action)]" />
      <span>
        {label}
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

// --- SMTP ------------------------------------------------------------------

export function SmtpForm({ smtp, hasPassword, source }: { smtp: SmtpSettings; hasPassword: boolean; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveSmtpSettings, null);
  const [test, sendTest, testing] = useActionState<SettingsResult | null, FormData>(sendTestEmail, null);
  useResultToast(state);
  useResultToast(test);
  const { formRef, run } = useFormRunner();

  return (
    <Card>
      <CardHeader
        eyebrow="Email"
        title="Outgoing mail (SMTP)"
        description="Used for verification, password reset, magic links, one-time codes and invitations. Without a host, mail is only logged to the web container's output."
        action={<HeaderAction section="smtp" source={source} />}
      />
      <CardBody>
        <form
          ref={formRef}
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(save);
          }}
        >
          <Field label="Host" htmlFor="smtp-host">
            <Input id="smtp-host" name="host" defaultValue={smtp.host} placeholder="smtp.example.com" className="font-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" htmlFor="smtp-port">
              <Input id="smtp-port" name="port" type="number" min={1} defaultValue={smtp.port} className="font-mono" />
            </Field>
            <div className="self-end pb-2">
              <Check name="secure" label="TLS (SMTPS)" defaultChecked={smtp.secure} hint="Port 465; STARTTLS is negotiated automatically otherwise" />
            </div>
          </div>
          <Field label="Username" htmlFor="smtp-user" hint="Leave empty for unauthenticated relays">
            <Input id="smtp-user" name="user" defaultValue={smtp.user} autoComplete="off" />
          </Field>
          <Field label="Password" htmlFor="smtp-pass" hint={secretHint(hasPassword)}>
            <Input id="smtp-pass" name="pass" type="password" autoComplete="new-password" placeholder={hasPassword ? "••••••••" : ""} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="From" htmlFor="smtp-from" hint="Display name and address, e.g. Chicorée <registry@example.com>">
              <Input id="smtp-from" name="from" defaultValue={smtp.from} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              Save email settings
            </Button>
            <Feedback state={state} />
          </div>
          <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4 sm:col-span-2">
            <div className="min-w-56 flex-1">
              <Field label="Send a test email to" htmlFor="smtp-test-to">
                <Input id="smtp-test-to" name="testTo" type="email" placeholder="you@example.com" />
              </Field>
            </div>
            <FieldAction>
              <Button type="button" variant="secondary" onClick={() => run(sendTest)} disabled={testing}>
                <Mail className="size-4" /> {testing ? "Sending…" : "Send test"}
              </Button>
            </FieldAction>
            <Feedback state={test} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// --- OAuth providers -------------------------------------------------------

export function OAuthProviderForm({
  provider,
  title,
  callbackUrl,
  values,
  hasSecret,
  source,
}: {
  provider: "github" | "google" | "oidc";
  title: string;
  callbackUrl: string;
  values: { enabled: boolean; clientId: string; issuer?: string; name?: string; scopes?: string; groupsClaim?: string };
  hasSecret: boolean;
  source: SettingsSource;
}) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveOAuthProvider, null);
  useResultToast(state);
  const isOidc = provider === "oidc";

  return (
    <Card>
      <CardHeader
        eyebrow="Sign-in provider"
        title={title}
        description={
          isOidc
            ? "Any OpenID Connect issuer (Keycloak, Authentik, Entra ID, …). Discovery runs against <issuer>/.well-known/openid-configuration."
            : `Register an OAuth app with ${title} and use the callback URL below.`
        }
        action={<HeaderAction section={provider} source={source} />}
      />
      <CardBody>
        <form action={save} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="provider" value={provider} />
          <div className="sm:col-span-2">
            <div className="eyebrow mb-1.5">Callback URL</div>
            <CommandLine command={callbackUrl} />
          </div>
          <div className="sm:col-span-2">
            <Check name="enabled" label={`Offer "${isOidc ? values.name || "SSO" : title}" on the sign-in page`} defaultChecked={values.enabled} />
          </div>
          {isOidc && (
            <>
              <Field label="Issuer URL" htmlFor={`${provider}-issuer`}>
                <Input id={`${provider}-issuer`} name="issuer" defaultValue={values.issuer} placeholder="https://id.example.com/realms/main" className="font-mono" />
              </Field>
              <Field label="Button label" htmlFor={`${provider}-name`}>
                <Input id={`${provider}-name`} name="name" defaultValue={values.name} placeholder="SSO" />
              </Field>
            </>
          )}
          <Field label="Client ID" htmlFor={`${provider}-client-id`}>
            <Input id={`${provider}-client-id`} name="clientId" defaultValue={values.clientId} className="font-mono" autoComplete="off" />
          </Field>
          <Field label="Client secret" htmlFor={`${provider}-client-secret`} hint={secretHint(hasSecret)}>
            <Input
              id={`${provider}-client-secret`}
              name="clientSecret"
              type="password"
              autoComplete="new-password"
              placeholder={hasSecret ? "••••••••" : ""}
              className="font-mono"
            />
          </Field>
          {isOidc && (
            <>
              <Field label="Scopes" htmlFor={`${provider}-scopes`} hint='Add "groups" when binding roles to OIDC groups'>
                <Input id={`${provider}-scopes`} name="scopes" defaultValue={values.scopes} className="font-mono" />
              </Field>
              <Field label="Groups claim" htmlFor={`${provider}-groups-claim`} hint="ID-token claim used by the group bindings">
                <Input id={`${provider}-groups-claim`} name="groupsClaim" defaultValue={values.groupsClaim} className="font-mono" />
              </Field>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              Save {title}
            </Button>
            <Feedback state={state} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// --- LDAP ------------------------------------------------------------------

export function LdapForm({ ldap, hasBindPassword, source }: { ldap: LdapSettings; hasBindPassword: boolean; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveLdapSettings, null);
  const [test, runTest, testing] = useActionState<SettingsResult | null, FormData>(testLdapSettings, null);
  useResultToast(state);
  useResultToast(test);
  const { formRef, run } = useFormRunner();

  return (
    <Card>
      <CardHeader
        eyebrow="Directory"
        title="LDAP / Active Directory"
        description="Users sign in with their directory username and password, in the browser and with docker login. Accounts are created on first login; map groups to roles under Group bindings."
        action={<HeaderAction section="ldap" source={source} />}
      />
      <CardBody>
        <form
          ref={formRef}
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(save);
          }}
        >
          <div className="sm:col-span-2">
            <Check name="enabled" label="Offer directory sign-in" defaultChecked={ldap.enabled} />
          </div>
          <Field label="Server URL" htmlFor="ldap-url" hint="ldap:// or ldaps://, with port if not the default">
            <Input id="ldap-url" name="url" defaultValue={ldap.url} placeholder="ldaps://ldap.example.com" className="font-mono" />
          </Field>
          <Field label="Button label" htmlFor="ldap-name">
            <Input id="ldap-name" name="name" defaultValue={ldap.name} placeholder="Company directory" />
          </Field>
          <Field label="Bind DN" htmlFor="ldap-bind-dn" hint="Read-only lookup account; empty for anonymous search">
            <Input id="ldap-bind-dn" name="bindDn" defaultValue={ldap.bindDn} className="font-mono" autoComplete="off" />
          </Field>
          <Field label="Bind password" htmlFor="ldap-bind-password" hint={secretHint(hasBindPassword)}>
            <Input id="ldap-bind-password" name="bindPassword" type="password" autoComplete="new-password" placeholder={hasBindPassword ? "••••••••" : ""} />
          </Field>
          <Field label="User search base" htmlFor="ldap-user-base">
            <Input id="ldap-user-base" name="userBase" defaultValue={ldap.userBase} placeholder="ou=people,dc=example,dc=com" className="font-mono" />
          </Field>
          <Field label="User filter" htmlFor="ldap-user-filter" hint="{{username}} is replaced; Active Directory: (&(objectClass=user)(sAMAccountName={{username}}))">
            <Input id="ldap-user-filter" name="userFilter" defaultValue={ldap.userFilter} className="font-mono" />
          </Field>
          <div className="grid grid-cols-3 gap-3 sm:col-span-2">
            <Field label="Email attribute" htmlFor="ldap-attr-email">
              <Input id="ldap-attr-email" name="attrEmail" defaultValue={ldap.attrEmail} className="font-mono" />
            </Field>
            <Field label="Name attribute" htmlFor="ldap-attr-name">
              <Input id="ldap-attr-name" name="attrName" defaultValue={ldap.attrName} className="font-mono" />
            </Field>
            <Field label="Groups attribute" htmlFor="ldap-attr-groups">
              <Input id="ldap-attr-groups" name="attrGroups" defaultValue={ldap.attrGroups} className="font-mono" />
            </Field>
          </div>
          <Field label="Group search base" htmlFor="ldap-group-base" hint="Only for directories without memberOf">
            <Input id="ldap-group-base" name="groupBase" defaultValue={ldap.groupBase} className="font-mono" />
          </Field>
          <Field label="Group filter" htmlFor="ldap-group-filter" hint="{{dn}} and {{username}} are replaced">
            <Input id="ldap-group-filter" name="groupFilter" defaultValue={ldap.groupFilter} className="font-mono" />
          </Field>
          <Field label="Email domain fallback" htmlFor="ldap-email-domain" hint="Entries without an email get <username>@<domain>">
            <Input id="ldap-email-domain" name="emailDomain" defaultValue={ldap.emailDomain} placeholder="example.com" />
          </Field>
          <Field label="Timeout (ms)" htmlFor="ldap-timeout">
            <Input id="ldap-timeout" name="timeoutMs" type="number" min={1000} defaultValue={ldap.timeoutMs} className="font-mono" />
          </Field>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
            <Check name="startTls" label="Use STARTTLS on ldap://" defaultChecked={ldap.startTls} />
            <Check name="tlsInsecure" label="Skip certificate verification" defaultChecked={ldap.tlsInsecure} hint="Only for self-signed test servers" />
          </div>
          <div className="sm:col-span-2">
            <Field label="CA certificate file" htmlFor="ldap-ca" hint="Path inside the web container, for private CAs">
              <Input id="ldap-ca" name="tlsCaFile" defaultValue={ldap.tlsCaFile} className="font-mono" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              Save LDAP settings
            </Button>
            <Feedback state={state} />
          </div>
          <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4 sm:col-span-2">
            <div className="min-w-56 flex-1">
              <Field label="Test with a username" htmlFor="ldap-test-username">
                <Input id="ldap-test-username" name="testUsername" placeholder="jdoe" />
              </Field>
            </div>
            <FieldAction>
              <Button type="button" variant="secondary" onClick={() => run(runTest)} disabled={testing}>
                <Plug className="size-4" /> {testing ? "Testing…" : "Test connection"}
              </Button>
            </FieldAction>
            <Feedback state={test} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// --- Group bindings --------------------------------------------------------

export function BindingsForm({ text, source }: { text: string; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveGroupBindings, null);
  useResultToast(state);
  return (
    <Card>
      <CardHeader
        eyebrow="Roles"
        title="Group bindings"
        description="Map directory or identity-provider groups to the instance administrator role or to organization roles. Re-applied on every sign-in through that provider; bindings are authoritative for the organizations they mention, per provider."
        action={<HeaderAction section="bindings" source={source} />}
      />
      <CardBody>
        <form action={save} className="space-y-4">
          <Field label="Bindings" htmlFor="bindings-text" hint="One per line or ;-separated: <group> => admin | <org-slug>:<owner|admin|member|viewer>">
            <Textarea
              id="bindings-text"
              name="text"
              defaultValue={text}
              rows={8}
              className="min-h-40 font-mono text-[13px]"
              placeholder={"cn=registry-admins,ou=groups,dc=example,dc=com => admin\ndevelopers => acme:member\ngithub:acme/platform => acme:owner\ngoogle:example.com => acme:viewer\noidc:ops => acme:admin"}
            />
          </Field>
          <div className="rounded-lg border border-line bg-card-2 px-4 py-3 text-xs text-ink-2">
            <div className="font-medium text-ink">Group identifiers</div>
            <div className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
              <span>LDAP: full DN or just the CN</span>
              <span>GitHub: github:&lt;org&gt; or github:&lt;org&gt;/&lt;team&gt;</span>
              <span>Google: google:&lt;domain&gt; or google:&lt;group email&gt;</span>
              <span>OIDC: oidc:&lt;groups-claim value&gt;</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              Save bindings
            </Button>
            <Feedback state={state} />
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
