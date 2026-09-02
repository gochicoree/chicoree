"use client";

import { useActionState } from "react";
import { Bot, Trash2 } from "lucide-react";
import { createServiceAccount, deleteServiceAccount, type SecretResult } from "@/app/actions/credentials";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { relativeTime } from "@/lib/format";

interface SaRow {
  id: string;
  name: string;
  description: string;
  permission: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

const PERMISSION_LABEL: Record<string, string> = {
  pull: "pull only",
  push: "pull + push",
  admin: "pull + push + delete",
};

export function ServiceAccountsManager({
  organizationId,
  registryHost,
  accounts,
}: {
  organizationId: string;
  registryHost: string;
  accounts: SaRow[];
}) {
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(
    createServiceAccount,
    null,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="CI credentials"
          title="Create a service account"
          description="Non-human credentials for pipelines. The secret is shown once — store it in your CI secret store."
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
            <Field label="Expires after" htmlFor="sa-expires">
              <Select
                id="sa-expires"
                name="expiresDays"
                defaultValue=""
                options={[
                  { value: "", label: "Never" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                ]}
              />
            </Field>
            <div className="sm:col-span-2">
              {state?.error && (
                <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                  {state.error}
                </p>
              )}
              <Button type="submit" disabled={pending}>
                Create service account
              </Button>
            </div>
          </form>

          {state?.secret && (
            <div className="mt-4 space-y-2 rounded-lg border border-accent/40 bg-accent-soft p-4">
              <p className="text-sm font-medium text-accent-ink">
                Credential for “{state.name}” — copy it now, it won't be shown again.
              </p>
              <CommandLine command={state.secret} />
              <p className="text-xs text-accent-ink/80">Use it in CI:</p>
              <CommandLine
                command={`echo $REGISTRY_TOKEN | docker login ${registryHost} -u ${state.name} --password-stdin`}
              />
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
            {accounts.map((sa) => (
              <div
                key={sa.id}
                className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5"
              >
                <Bot className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{sa.name}</span>
                    <Badge>{PERMISSION_LABEL[sa.permission] ?? sa.permission}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-2">
                    <span className="font-mono">{sa.tokenPrefix}</span> · created{" "}
                    {relativeTime(sa.createdAt)} · last used {relativeTime(sa.lastUsedAt)}
                    {sa.expiresAt && ` · expires ${new Date(sa.expiresAt).toLocaleDateString()}`}
                  </div>
                  {sa.description && <div className="mt-0.5 text-xs text-ink-3">{sa.description}</div>}
                </div>
                <form action={deleteServiceAccount}>
                  <input type="hidden" name="id" value={sa.id} />
                  <button
                    type="submit"
                    aria-label={`Delete ${sa.name}`}
                    className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </form>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
