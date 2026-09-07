"use client";

import { useActionState, useEffect, useRef } from "react";
import { ExternalLink, RotateCcw, Scale } from "lucide-react";
import { resetSection, savePortalSettings, saveQuotaDefaults, type SettingsResult } from "@/app/actions/instance-settings";
import type { PortalSettings, QuotaDefaults, SettingsSource } from "@/lib/instance-settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { ConfirmForm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";

function useResultToast(state: SettingsResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message });
  }, [state, toast]);
}

function SourceBadge({ source, none }: { source: SettingsSource; none: string }) {
  if (source === "database") return <Badge tone="ok">saved in admin settings</Badge>;
  if (source === "environment") return <Badge tone="info">from environment</Badge>;
  return <Badge>{none}</Badge>;
}

function ResetButton({ section }: { section: "quotas" | "portal" }) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(resetSection, null);
  useResultToast(state);
  const what = section === "portal" ? "portal settings" : "default limits";
  return (
    <ConfirmForm
      action={action}
      title={`Discard the saved ${what}?`}
      description={`The ${what} saved here are removed and the values from the environment apply again.`}
      confirmLabel="Use environment values"
      tone="danger"
    >
      <input type="hidden" name="section" value={section} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <RotateCcw className="size-3.5" /> Use environment values
      </Button>
    </ConfirmForm>
  );
}

const gib = (bytes: number | null) => (bytes === null ? "" : String(Math.round((bytes / 1024 ** 3) * 10) / 10));

function LimitInput({ id, name, value, min = 0, step }: { id: string; name: string; value: number | null | string; min?: number; step?: string }) {
  return <Input id={id} name={name} type="number" min={min} step={step} placeholder="unlimited" defaultValue={value ?? ""} />;
}

export function QuotaDefaultsForm({ values, source }: { values: QuotaDefaults; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(saveQuotaDefaults, null);
  useResultToast(state);
  return (
    <Card>
      <CardHeader
        eyebrow="Defaults"
        title="Limits for new accounts and organizations"
        description="Applied once, when an account signs up or an organization is created. Leave a field empty for no limit; administrators are never limited."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={source} none="no defaults" />
            {source === "database" && <ResetButton section="quotas" />}
          </div>
        }
      />
      <CardBody>
        <form action={save} className="space-y-6">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">New accounts</legend>
            <p className="mb-3 text-xs text-ink-2">Summed across every organization the account owns.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Organizations" htmlFor="q-user-orgs" hint="They can create">
                <LimitInput id="q-user-orgs" name="userMaxOrganizations" value={values.user.maxOrganizations} />
              </Field>
              <Field label="Public repositories" htmlFor="q-user-public">
                <LimitInput id="q-user-public" name="userMaxPublicRepos" value={values.user.maxPublicRepos} />
              </Field>
              <Field label="Private repositories" htmlFor="q-user-private">
                <LimitInput id="q-user-private" name="userMaxPrivateRepos" value={values.user.maxPrivateRepos} />
              </Field>
              <Field label="Storage (GiB)" htmlFor="q-user-storage" hint="Deduplicated bytes">
                <LimitInput id="q-user-storage" name="userMaxStorageGiB" value={gib(values.user.maxStorageBytes)} step="0.1" />
              </Field>
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink">New organizations</legend>
            <p className="mb-3 text-xs text-ink-2">Per organization; the owner&apos;s account limits apply on top.</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Public repositories" htmlFor="q-org-public">
                <LimitInput id="q-org-public" name="orgMaxPublicRepos" value={values.organization.maxPublicRepos} />
              </Field>
              <Field label="Private repositories" htmlFor="q-org-private">
                <LimitInput id="q-org-private" name="orgMaxPrivateRepos" value={values.organization.maxPrivateRepos} />
              </Field>
              <Field label="Storage (GiB)" htmlFor="q-org-storage" hint="Deduplicated bytes">
                <LimitInput id="q-org-storage" name="orgMaxStorageGiB" value={gib(values.organization.maxStorageBytes)} step="0.1" />
              </Field>
              <Field label="Members" htmlFor="q-org-members" hint="Open invitations count">
                <LimitInput id="q-org-members" name="orgMaxMembers" value={values.organization.maxMembers} min={1} />
              </Field>
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              <Scale className="size-4" /> Save default limits
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function PortalForm({ values, source }: { values: PortalSettings; source: SettingsSource }) {
  const [state, save, saving] = useActionState<SettingsResult | null, FormData>(savePortalSettings, null);
  useResultToast(state);
  return (
    <Card>
      <CardHeader
        eyebrow="Account portal"
        title="Where people manage their account"
        description="With a URL set, account and organization settings show a Manage button that opens it with a short-lived sign-in token, so the other service knows who arrived."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={source} none="no portal" />
            {source === "database" && <ResetButton section="portal" />}
          </div>
        }
      />
      <CardBody>
        <form action={save} className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Portal URL" htmlFor="portal-url" hint="Receives ?token=… and, from an organization, &organization=<slug>">
              <Input id="portal-url" name="url" type="url" defaultValue={values.url} placeholder="https://account.example.com/portal" className="font-mono" autoComplete="off" />
            </Field>
          </div>
          <Field label="Button label" htmlFor="portal-label" hint="Empty = Manage">
            <Input id="portal-label" name="label" defaultValue={values.label} maxLength={40} placeholder="Manage" />
          </Field>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <Button type="submit" disabled={saving}>
              <ExternalLink className="size-4" /> Save portal
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
