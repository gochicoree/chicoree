"use client";

import { useActionState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { createAccessToken, deleteAccessToken, type SecretResult } from "@/app/actions/credentials";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { relativeTime } from "@/lib/format";

interface TokenRow {
  id: string;
  name: string;
  scope: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export function TokenManager({
  registryHost,
  email,
  tokens,
}: {
  registryHost: string;
  email: string;
  tokens: TokenRow[];
}) {
  const [state, action, pending] = useActionState<SecretResult | null, FormData>(
    createAccessToken,
    null,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Docker login"
          title="Create an access token"
          description="Tokens are how you docker login — they respect your organization roles and work with two-factor auth."
        />
        <CardBody>
          <form action={action} className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="pat-name" hint="e.g. work-laptop">
              <Input id="pat-name" name="name" required />
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
            <Field label="Expires after" htmlFor="pat-expires">
              <Select
                id="pat-expires"
                name="expiresDays"
                defaultValue="90"
                options={[
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                  { value: "", label: "Never" },
                ]}
              />
            </Field>
            <div className="sm:col-span-3">
              {state?.error && (
                <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                  {state.error}
                </p>
              )}
              <Button type="submit" disabled={pending}>
                Create token
              </Button>
            </div>
          </form>

          {state?.secret && (
            <div className="mt-4 space-y-2 rounded-lg border border-accent/40 bg-accent-soft p-4">
              <p className="text-sm font-medium text-accent-ink">
                Token “{state.name}” — copy it now, it won't be shown again.
              </p>
              <CommandLine command={state.secret} />
              <p className="text-xs text-accent-ink/80">Sign in to the registry with it:</p>
              <CommandLine command={`docker login ${registryHost} -u ${email}`} />
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
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
                <KeyRound className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.name}</span>
                    <Badge>{t.scope === "read" ? "read only" : "read & write"}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-2">
                    <span className="font-mono">{t.tokenPrefix}</span> · created {relativeTime(t.createdAt)} ·
                    last used {relativeTime(t.lastUsedAt)}
                    {t.expiresAt && ` · expires ${new Date(t.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
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
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
