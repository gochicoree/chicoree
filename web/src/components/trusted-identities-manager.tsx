"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Plus, Trash2 } from "lucide-react";
import { addTrustedIdentityAction, removeTrustedIdentityAction, type TrustedIdentityResult } from "@/app/actions/trusted-identities";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

export interface TrustedIdentityItem {
  id: string;
  name: string;
  issuer: string;
  subject: string;
  repositoryId: string | null;
  createdAt: string;
}

/** Common OIDC issuers Fulcio records; "custom" shows a free text field. */
const ISSUERS = [
  { value: "https://token.actions.githubusercontent.com", label: "GitHub Actions", hint: "https://github.com/<org>/<repo>/.github/workflows/<file>.yml@refs/tags/*" },
  { value: "https://gitlab.com", label: "GitLab CI", hint: "https://gitlab.com/<group>/<project>//.gitlab-ci.yml@refs/heads/main" },
  { value: "https://accounts.google.com", label: "Google account", hint: "name@example.com or *@example.com" },
  { value: "https://github.com/login/oauth", label: "GitHub account", hint: "the account's email address" },
  { value: "https://login.microsoftonline.com", label: "Microsoft account", hint: "name@example.com" },
  { value: "custom", label: "Other issuer", hint: "the subject exactly as the certificate names it (* matches anything)" },
];

function issuerLabel(issuer: string): string {
  return ISSUERS.find((i) => i.value === issuer)?.label ?? issuer;
}

function RemoveIdentityButton({ item }: { item: TrustedIdentityItem }) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function confirm() {
    const data = new FormData();
    data.set("id", item.id);
    start(async () => {
      const res = await removeTrustedIdentityAction(data);
      if (res.error) toast({ title: "Could not remove the identity", description: res.error, tone: "error" });
      else toast({ title: `Removed identity ${item.name}`, description: "Signatures in scope were re-verified." });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Remove identity ${item.name}`}
        className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer pointer-coarse:p-2"
      >
        <Trash2 className="size-4" />
      </button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Removing…" : "Remove identity"}
        title={`Remove identity ${item.name}?`}
        description="Signatures made by this identity no longer count as verified. Images that require a signature may stop being pullable."
      />
    </>
  );
}

function IdentityTable({ items, scope, readOnly }: { items: TrustedIdentityItem[]; scope: "organization" | "repository"; readOnly?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-4 py-2 text-xs font-medium text-ink-2 sm:px-5">Name</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-2">Issuer</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-2">Subject</th>
            <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Scope</th>
            {!readOnly && <th className="w-10 px-2 py-2" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-b border-line last:border-0">
              <td className="px-4 py-2.5 font-medium sm:px-5">
                <span className="inline-flex items-center gap-1.5">
                  <Fingerprint className="size-3.5 text-ink-3" /> {i.name}
                </span>
              </td>
              <td className="px-4 py-2.5 text-xs text-ink-2" title={i.issuer}>
                {issuerLabel(i.issuer)}
              </td>
              <td className="max-w-[28rem] px-4 py-2.5 font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">{i.subject}</td>
              <td className="hidden px-4 py-2.5 text-xs text-ink-2 sm:table-cell">
                {i.repositoryId ? "this repository" : scope === "repository" ? "organization-wide" : "every repository"}
              </td>
              {!readOnly && (
                <td className="px-2 py-1.5 text-right">
                  <RemoveIdentityButton item={i} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Trusted keyless identities card: the Sigstore identities (OIDC issuer +
 * subject) whose keyless cosign signatures count as verified, for an
 * organization or one repository (which also lists the organization-wide
 * identities it inherits, read-only).
 */
export function TrustedIdentitiesManager({
  scope,
  organizationId,
  repositoryId,
  identities,
  inherited = [],
}: {
  scope: "organization" | "repository";
  organizationId: string;
  repositoryId?: string;
  identities: TrustedIdentityItem[];
  inherited?: TrustedIdentityItem[];
}) {
  const [state, action, pending] = useActionState<TrustedIdentityResult | null, FormData>(addTrustedIdentityAction, null);
  const [issuer, setIssuer] = useState(ISSUERS[0].value);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.saved) {
      toast({ title: "Trusted identity added", description: "Signatures in scope were re-verified." });
      formRef.current?.reset();
      setIssuer(ISSUERS[0].value);
    }
  }, [state, toast]);
  const preset = ISSUERS.find((i) => i.value === issuer) ?? ISSUERS[ISSUERS.length - 1];

  return (
    <Card>
      <CardHeader
        eyebrow="Supply chain"
        title="Trusted keyless identities"
        description={
          scope === "organization"
            ? "Who may sign with cosign keyless (Sigstore). A signature counts as verified when its certificate is valid and names one of these identities."
            : "Keyless identities trusted for this repository, in addition to the organization's."
        }
      />
      {identities.length > 0 ? (
        <div className="overflow-x-auto border-b border-line">
          <IdentityTable items={identities} scope={scope} />
        </div>
      ) : (
        <p className="border-b border-line px-4 py-3 text-sm text-ink-3 sm:px-5">
          No trusted identities yet. Keyless signatures show their identity on the image page; add it here to accept it.
        </p>
      )}
      <CardBody>
        <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="organizationId" value={organizationId} />
          {repositoryId && <input type="hidden" name="repositoryId" value={repositoryId} />}
          <Field label="Name" htmlFor={`identity-name-${scope}`} hint="e.g. release workflow">
            <Input id={`identity-name-${scope}`} name="name" required placeholder="release workflow" maxLength={80} />
          </Field>
          <Field label="Issuer" htmlFor={`identity-issuer-${scope}`}>
            <Select id={`identity-issuer-${scope}`} options={ISSUERS.map(({ value, label }) => ({ value, label }))} value={issuer} onChange={setIssuer} />
          </Field>
          {issuer === "custom" ? (
            <Field label="Issuer URL" htmlFor={`identity-issuer-url-${scope}`} hint="As shown on the image page">
              <Input id={`identity-issuer-url-${scope}`} name="issuer" required className="font-mono" placeholder="https://oidc.example.com" />
            </Field>
          ) : (
            <input type="hidden" name="issuer" value={issuer} />
          )}
          <div className={issuer === "custom" ? "" : "sm:col-span-2"}>
            <Field label="Subject" htmlFor={`identity-subject-${scope}`} hint={preset.hint}>
              <Input id={`identity-subject-${scope}`} name="subject" required className="font-mono" placeholder={preset.hint} maxLength={500} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" variant="secondary" disabled={pending}>
              <Plus className="size-4" /> {pending ? "Adding…" : "Trust identity"}
            </Button>
            {state?.error && <p className="text-sm text-danger">{state.error}</p>}
          </div>
        </form>
      </CardBody>
      {scope === "repository" && inherited.length > 0 && (
        <div className="border-t border-line">
          <div className="px-4 pt-3 sm:px-5">
            <div className="eyebrow">Inherited from the organization</div>
            <p className="mt-0.5 text-xs text-ink-3">Managed under Organization → Settings → Policies.</p>
          </div>
          <div className="overflow-x-auto">
            <IdentityTable items={inherited} scope="repository" readOnly />
          </div>
        </div>
      )}
    </Card>
  );
}
