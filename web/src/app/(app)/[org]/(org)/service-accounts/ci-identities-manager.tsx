"use client";

import { useActionState, useState } from "react";
import { KeySquare, Trash2 } from "lucide-react";
import { addCiIdentity, removeCiIdentity, type CiIdentityResult } from "@/app/actions/ci-identities";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { ConfirmForm } from "@/components/ui/confirm";
import { relativeTime } from "@/lib/format";

export interface CiIdentityRowView {
  id: string;
  name: string;
  issuer: string;
  subject: string;
  permission: string;
  repositories: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastSubject: string | null;
}

const ISSUERS = [
  { value: "https://token.actions.githubusercontent.com", label: "GitHub Actions", hint: "repo:owner/repo:ref:refs/heads/main (or repo:owner/repo:*)" },
  { value: "https://gitlab.com", label: "GitLab.com", hint: "project_path:group/project:ref_type:branch:ref:main" },
  { value: "custom", label: "Other issuer", hint: "The sub claim of the token, * wildcards allowed" },
];

const PERMISSION_LABEL: Record<string, string> = { pull: "pull only", push: "pull + push", admin: "pull + push + delete" };

function issuerLabel(issuer: string): string {
  return ISSUERS.find((i) => i.value === issuer)?.label ?? issuer;
}

export function CiIdentitiesManager({ organizationId, organizationSlug, appUrl, identities }: { organizationId: string; organizationSlug: string; appUrl: string; identities: CiIdentityRowView[] }) {
  const [state, action, pending] = useActionState<CiIdentityResult | null, FormData>(addCiIdentity, null);
  const [issuerChoice, setIssuerChoice] = useState(ISSUERS[0].value);
  const preset = ISSUERS.find((i) => i.value === issuerChoice) ?? ISSUERS[2];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Keyless CI"
          title="Trust a CI identity"
          description="A workflow signs in with the OIDC token its CI system issues — no secret to store or rotate. It gets the permission below for the time of the job."
        />
        <CardBody>
          <form action={action} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="organizationId" value={organizationId} />
            <Field label="Name" htmlFor="ci-name" hint="e.g. github-main">
              <Input id="ci-name" name="name" required className="font-mono" pattern="[a-z0-9]+([._\\-][a-z0-9]+)*" />
            </Field>
            <Field label="Permission" htmlFor="ci-permission">
              <Select
                id="ci-permission"
                name="permission"
                defaultValue="push"
                options={[
                  { value: "pull", label: "Pull only", description: "Deploy jobs" },
                  { value: "push", label: "Pull + push", description: "Build jobs" },
                  { value: "admin", label: "Pull + push + delete", description: "Cleanup jobs" },
                ]}
              />
            </Field>
            <Field label="Issuer" htmlFor="ci-issuer-choice">
              <Select id="ci-issuer-choice" value={issuerChoice} onChange={setIssuerChoice} options={ISSUERS.map((i) => ({ value: i.value, label: i.label }))} />
              {issuerChoice === "custom" ? (
                <Input name="issuer" placeholder="https://issuer.example.com" className="mt-2 font-mono" required />
              ) : (
                <input type="hidden" name="issuer" value={issuerChoice} />
              )}
            </Field>
            <Field label="Subject" htmlFor="ci-subject" hint={preset.hint}>
              <Input id="ci-subject" name="subject" required className="font-mono" placeholder={issuerChoice.includes("github") ? "repo:acme/app:ref:refs/heads/main" : ""} />
            </Field>
            <Field label="Repositories" htmlFor="ci-repositories" hint="Optional: comma-separated names to limit the identity to.">
              <Input id="ci-repositories" name="repositories" className="font-mono" placeholder="api, web" />
            </Field>
            <div className="sm:col-span-2">
              {state?.error && <p className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
              <Button type="submit" disabled={pending}>
                Trust identity
              </Button>
            </div>
          </form>
          <div className="mt-5 space-y-2">
            <p className="text-xs text-ink-2">In a GitHub Actions job (needs <code className="font-mono">permissions: id-token: write</code>):</p>
            <CommandLine command={`- uses: gochicoree/chicoree/.github/actions/login@main\n  with:\n    registry-url: ${appUrl}\n    organization: ${organizationSlug}`} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Trusted" title={`CI identities (${identities.length})`} />
        {identities.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">No CI identities yet.</p>
          </CardBody>
        ) : (
          <div>
            {identities.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
                <KeySquare className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{i.name}</span>
                    <Badge>{PERMISSION_LABEL[i.permission] ?? i.permission}</Badge>
                    <Badge tone="info">{issuerLabel(i.issuer)}</Badge>
                    {i.repositories && <Badge tone="neutral">{i.repositories.join(", ")}</Badge>}
                  </div>
                  <div className="mt-0.5 break-all font-mono text-xs text-ink-2">{i.subject}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    added {relativeTime(i.createdAt)} · {i.lastUsedAt ? `last used ${relativeTime(i.lastUsedAt)}${i.lastSubject ? ` by ${i.lastSubject}` : ""}` : "never used"}
                  </div>
                </div>
                <ConfirmForm
                  action={removeCiIdentity}
                  title={`Remove ${i.name}?`}
                  description="Workflows signing in with this identity are turned away from now on. You can trust it again later."
                  confirmLabel="Remove identity"
                  tone="danger"
                >
                  <input type="hidden" name="id" value={i.id} />
                  <button type="submit" aria-label={`Remove ${i.name}`} className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer">
                    <Trash2 className="size-4" />
                  </button>
                </ConfirmForm>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
