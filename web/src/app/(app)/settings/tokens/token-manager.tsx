"use client";

import { useActionState, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { createAccessToken, deleteAccessToken, rotateAccessToken, type SecretResult } from "@/app/actions/credentials";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { ConfirmModal, Modal } from "@/components/ui/modal";
import { relativeTime } from "@/lib/format";
import {
  CUSTOM,
  defaultExpiryChoice,
  describeExpiryPolicy,
  describeRestriction,
  expiryOptions,
  expiryState,
  describeExpiry,
  lastUsedText,
  type TokenExpiryPolicy,
} from "@/lib/token-policy-shared";

export interface TokenRow {
  id: string;
  name: string;
  description: string;
  scope: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  organization: { name: string; slug: string } | null;
  repositories: string[] | null;
}

export interface TokenOrg {
  id: string;
  name: string;
  slug: string;
  repositories: { id: string; name: string }[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Expiry select + custom date input, shared by the token and service-account forms. */
export function ExpiryFields({
  policy,
  idPrefix,
  defaultChoice,
}: {
  policy: TokenExpiryPolicy;
  idPrefix: string;
  /** Initial selection; defaults to the policy's default choice. */
  defaultChoice?: string;
}) {
  const options = expiryOptions(policy);
  const initial = defaultChoice && options.some((o) => o.value === defaultChoice) ? defaultChoice : defaultExpiryChoice(policy);
  const [choice, setChoice] = useState(initial);
  const today = new Date();
  const min = isoDate(new Date(today.getTime() + 86_400_000));
  const max = policy.maxTokenLifetimeDays > 0 ? isoDate(new Date(today.getTime() + policy.maxTokenLifetimeDays * 86_400_000)) : undefined;
  const hint = describeExpiryPolicy(policy);
  return (
    <>
      <Field label="Expires" htmlFor={`${idPrefix}-expires`} hint={hint || undefined}>
        <Select id={`${idPrefix}-expires`} name="expires" value={choice} onChange={setChoice} options={options} />
      </Field>
      {choice === CUSTOM && (
        <Field label="Expiry date" htmlFor={`${idPrefix}-expires-on`} hint={max ? `No later than ${max}` : undefined}>
          <DatePicker id={`${idPrefix}-expires-on`} name="expiresOn" min={min} max={max} clearable={false} placeholder="Choose the last valid day" />
        </Field>
      )}
    </>
  );
}

/** Lifecycle badge: red when the credential expires within a week, greyed when it already did. */
export function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const s = expiryState(expiresAt);
  const text = describeExpiry(expiresAt);
  if (s.state === "expired") return <Badge tone="neutral" title={expiresAt ?? undefined}>{text}</Badge>;
  if (s.state === "expiring") return <Badge tone="danger" title={expiresAt ?? undefined}>{text}</Badge>;
  if (s.state === "never") return <Badge tone="neutral">never expires</Badge>;
  return (
    <Badge tone="neutral" title={text}>
      expires {new Date(expiresAt!).toLocaleDateString()}
    </Badge>
  );
}

/** Shows a freshly minted secret once. */
export function SecretPanel({ title, secret, children }: { title: string; secret: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-accent/40 bg-accent-soft p-4" data-secret-panel>
      <p className="text-sm font-medium text-accent-ink">{title}</p>
      <CommandLine command={secret} />
      {children}
    </div>
  );
}

function RotateButton({ token, registryHost, email }: { token: TokenRow; registryHost: string; email: string }) {
  const [confirm, setConfirm] = useState(false);
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(rotateAccessToken, null);
  const [shown, setShown] = useState<SecretResult | null>(null);
  useEffect(() => {
    if (state?.secret) {
      setShown(state);
      setConfirm(false);
    }
  }, [state]);
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirm(true)}
        aria-label={`Rotate ${token.name}`}
        title="Rotate: new secret, same settings; the old secret stops working"
        className="rounded-md p-1.5 text-ink-3 hover:bg-card-2 hover:text-ink cursor-pointer"
      >
        <RefreshCw className="size-4" />
      </button>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("id", token.id);
          action(fd);
        }}
        title={`Rotate “${token.name}”?`}
        description="You get a new secret with the same settings. The old one stops working right away."
        confirmLabel={pending ? "Rotating…" : "Rotate token"}
        tone="accent"
        busy={pending}
      >
        {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
      </ConfirmModal>
      <Modal open={!!shown} onClose={() => setShown(null)} title={`New secret for “${token.name}”`} description="Copy it now — it will not be shown again.">
        {shown?.secret && (
          <SecretPanel title="Replacement token" secret={shown.secret}>
            <p className="text-xs text-accent-ink/80">Sign in to the registry with it:</p>
            <CommandLine command={`docker login ${registryHost} -u ${email}`} />
          </SecretPanel>
        )}
      </Modal>
    </>
  );
}

export function TokenManager({
  registryHost,
  apiUrl,
  email,
  tokens,
  orgs,
  policy,
}: {
  registryHost: string;
  /** Absolute base of the REST API, for the example call shown with a new secret. */
  apiUrl: string;
  email: string;
  tokens: TokenRow[];
  orgs: TokenOrg[];
  policy: TokenExpiryPolicy;
}) {
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(createAccessToken, null);
  const [orgId, setOrgId] = useState("");
  const selectedOrg = orgs.find((o) => o.id === orgId) ?? null;
  const orgOptions = [
    { value: "", label: "Any organization", description: "Everything your roles allow" },
    ...orgs.map((o) => ({ value: o.id, label: o.name, description: o.slug })),
  ];
  const policyText = describeExpiryPolicy(policy);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Docker login"
          title="Create an access token"
          description="Use a token as the password for docker login or as a bearer token for the REST API. Optionally limit it to one organization or a few repositories."
        />
        <CardBody>
          <form action={action} className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="pat-name" hint="e.g. work-laptop">
              <Input id="pat-name" name="name" required maxLength={64} />
            </Field>
            <Field label="Scope" htmlFor="pat-scope">
              <Select
                id="pat-scope"
                name="scope"
                defaultValue="write"
                options={[
                  { value: "write", label: "Read & write", description: "Pull and push" },
                  { value: "read", label: "Read only", description: "Pull" },
                ]}
              />
            </Field>
            <ExpiryFields policy={policy} idPrefix="pat" />
            <Field label="Description" htmlFor="pat-description">
              <Input id="pat-description" name="description" placeholder="Optional — what uses it" maxLength={200} />
            </Field>
            <Field label="Organization" htmlFor="pat-org" hint={orgs.length ? "Restrict the token to one organization" : "Join an organization to restrict tokens to it"}>
              <Select id="pat-org" name="organizationId" value={orgId} onChange={setOrgId} options={orgOptions} disabled={orgs.length === 0} />
            </Field>
            {selectedOrg && (
              <div className="sm:col-span-3">
                <div className="mb-1.5 text-[13px] font-medium text-ink">Repositories in {selectedOrg.name}</div>
                {selectedOrg.repositories.length === 0 ? (
                  <p className="text-xs text-ink-3">No repositories yet — the token covers the whole organization.</p>
                ) : (
                  <>
                    <div className="grid gap-1.5 sm:grid-cols-3" data-repo-list>
                      {selectedOrg.repositories.map((r) => (
                        <label key={r.id} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm hover:bg-card-2">
                          <input type="checkbox" name="repositoryIds" value={r.id} className="size-4 accent-[var(--action)]" />
                          <span className="truncate font-mono text-[13px]">{r.name}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-2">Select none for the whole organization. A limited token cannot create repositories.</p>
                  </>
                )}
              </div>
            )}
            <div className="sm:col-span-3">
              {state?.error && (
                <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" data-form-error>
                  {state.error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                  Create token
                </Button>
                {policyText && <span className="text-xs text-ink-3">{policyText}</span>}
              </div>
            </div>
          </form>

          {state?.secret && (
            <div className="mt-4">
              <SecretPanel title={`Token “${state.name}” — copy it now, it won't be shown again.`} secret={state.secret}>
                <p className="text-xs text-accent-ink/80">Sign in to the registry with it:</p>
                <CommandLine command={`docker login ${registryHost} -u ${email}`} />
                <p className="text-xs text-accent-ink/80">Or call the REST API:</p>
                <CommandLine command={`curl -H "Authorization: Bearer <token>" ${apiUrl}/me`} />
              </SecretPanel>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Existing" title={`Access tokens (${tokens.length})`} />
        {tokens.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">No tokens yet — create one to docker login.</p>
          </CardBody>
        ) : (
          <div>
            {tokens.map((t) => {
              const expired = expiryState(t.expiresAt).state === "expired";
              return (
                <div
                  key={t.id}
                  data-token-row={t.name}
                  data-expired={expired ? "true" : undefined}
                  className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5 ${expired ? "opacity-60" : ""}`}
                >
                  <KeyRound className="size-4 shrink-0 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      <Badge>{t.scope === "read" ? "read only" : "read & write"}</Badge>
                      <ExpiryBadge expiresAt={t.expiresAt} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-2">
                      <span className="font-mono">{t.tokenPrefix}</span> · created {relativeTime(t.createdAt)} · {lastUsedText(t.lastUsedAt, t.lastUsedIp)} ·{" "}
                      <span title="Where the token may be used">{describeRestriction(t.organization?.name ?? null, t.repositories)}</span>
                    </div>
                    {t.description && <div className="mt-0.5 text-xs text-ink-3">{t.description}</div>}
                  </div>
                  <RotateButton token={t} registryHost={registryHost} email={email} />
                  <form action={deleteAccessToken}>
                    <input type="hidden" name="id" value={t.id} />
                    <button
                      type="submit"
                      aria-label={`Revoke ${t.name}`}
                      className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </form>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
