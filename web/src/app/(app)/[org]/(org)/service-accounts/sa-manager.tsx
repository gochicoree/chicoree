"use client";

import { useActionState, useEffect, useState } from "react";
import { Bot, RefreshCw, Trash2 } from "lucide-react";
import { createServiceAccount, deleteServiceAccount, rotateServiceAccount, type SecretResult } from "@/app/actions/credentials";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { ConfirmModal, Modal } from "@/components/ui/modal";
import { ConfirmForm } from "@/components/ui/confirm";
import { relativeTime } from "@/lib/format";
import { NEVER, describeExpiryPolicy, expiryState, lastUsedText, type TokenExpiryPolicy } from "@/lib/token-policy-shared";
import { ExpiryBadge, ExpiryFields, SecretPanel } from "@/app/(app)/settings/tokens/token-manager";

interface SaRow {
  id: string;
  name: string;
  description: string;
  permission: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

const PERMISSION_LABEL: Record<string, string> = {
  pull: "pull only",
  push: "pull + push",
  admin: "pull + push + delete",
};

function RotateButton({ sa, registryHost }: { sa: SaRow; registryHost: string }) {
  const [confirm, setConfirm] = useState(false);
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(rotateServiceAccount, null);
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
        aria-label={`Rotate ${sa.name}`}
        title="Rotate: new secret, same permissions; the old secret stops working"
        className="rounded-md p-1.5 text-ink-3 hover:bg-card-2 hover:text-ink cursor-pointer"
      >
        <RefreshCw className="size-4" />
      </button>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("id", sa.id);
          action(fd);
        }}
        title={`Rotate “${sa.name}”?`}
        description="The account keeps its settings and gets a new secret. The old one stops working right away."
        confirmLabel={pending ? "Rotating…" : "Rotate secret"}
        tone="accent"
        busy={pending}
      >
        {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
      </ConfirmModal>
      <Modal open={!!shown} onClose={() => setShown(null)} title={`New secret for “${sa.name}”`} description="Copy it now — it will not be shown again.">
        {shown?.secret && (
          <SecretPanel title="Replacement credential" secret={shown.secret}>
            <p className="text-xs text-accent-ink/80">Use it in CI:</p>
            <CommandLine command={`echo $REGISTRY_TOKEN | docker login ${registryHost} -u ${sa.name} --password-stdin`} />
          </SecretPanel>
        )}
      </Modal>
    </>
  );
}

export function ServiceAccountsManager({
  organizationId,
  registryHost,
  accounts,
  policy,
}: {
  organizationId: string;
  registryHost: string;
  accounts: SaRow[];
  policy: TokenExpiryPolicy;
}) {
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(
    createServiceAccount,
    null,
  );
  const policyText = describeExpiryPolicy(policy);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="CI credentials"
          title="Create a service account"
          description="Credentials for CI and other machines."
        />
        <CardBody>
          <form action={action} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="organizationId" value={organizationId} />
            <Field label="Name" htmlFor="sa-name" hint="e.g. github-actions, deploy-bot">
              <Input
                id="sa-name"
                name="name"
                required
                className="font-mono"
                pattern="[a-z0-9]+([._\\-][a-z0-9]+)*"
              />
            </Field>
            <Field label="Permission" htmlFor="sa-permission">
              <Select
                id="sa-permission"
                name="permission"
                defaultValue="push"
                options={[
                  { value: "pull", label: "Pull only", description: "Deploy targets" },
                  { value: "push", label: "Pull + push", description: "Build pipelines" },
                  { value: "admin", label: "Pull + push + delete", description: "Cleanup jobs" },
                ]}
              />
            </Field>
            <Field label="Description" htmlFor="sa-description">
              <Input id="sa-description" name="description" placeholder="Optional" />
            </Field>
            <ExpiryFields policy={policy} idPrefix="sa" defaultChoice={policy.requireTokenExpiry ? undefined : NEVER} />
            <div className="sm:col-span-2">
              {state?.error && (
                <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" data-form-error>
                  {state.error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                  Create service account
                </Button>
                {policyText && <span className="text-xs text-ink-3">{policyText}</span>}
              </div>
            </div>
          </form>

          {state?.secret && (
            <div className="mt-4">
              <SecretPanel title={`Credential for “${state.name}” — copy it now, it won't be shown again.`} secret={state.secret}>
                <p className="text-xs text-accent-ink/80">Use it in CI:</p>
                <CommandLine
                  command={`echo $REGISTRY_TOKEN | docker login ${registryHost} -u ${state.name} --password-stdin`}
                />
              </SecretPanel>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Existing" title={`Service accounts (${accounts.length})`} />
        {accounts.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">No service accounts yet.</p>
          </CardBody>
        ) : (
          <div>
            {accounts.map((sa) => {
              const expired = expiryState(sa.expiresAt).state === "expired";
              return (
                <div
                  key={sa.id}
                  data-sa-row={sa.name}
                  className={`flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5 ${expired ? "opacity-60" : ""}`}
                >
                  <Bot className="size-4 shrink-0 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">{sa.name}</span>
                      <Badge>{PERMISSION_LABEL[sa.permission] ?? sa.permission}</Badge>
                      <ExpiryBadge expiresAt={sa.expiresAt} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-2">
                      <span className="font-mono">{sa.tokenPrefix}</span> · created {relativeTime(sa.createdAt)} · {lastUsedText(sa.lastUsedAt, sa.lastUsedIp)}
                    </div>
                    {sa.description && <div className="mt-0.5 text-xs text-ink-3">{sa.description}</div>}
                  </div>
                  <RotateButton sa={sa} registryHost={registryHost} />
                  <ConfirmForm
                    action={deleteServiceAccount}
                    title={`Delete ${sa.name}?`}
                    description="Its credentials stop working immediately; anything that signs in with them fails from then on. This cannot be undone."
                    confirmLabel="Delete service account"
                    tone="danger"
                  >
                    <input type="hidden" name="id" value={sa.id} />
                    <button
                      type="submit"
                      aria-label={`Delete ${sa.name}`}
                      className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </ConfirmForm>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
