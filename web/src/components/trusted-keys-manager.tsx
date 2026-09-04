"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { addTrustedKeyAction, removeTrustedKeyAction, type SigningKeyResult } from "@/app/actions/trusted-keys";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { ConfirmModal } from "@/components/ui/modal";
import { CopyButton } from "@/components/ui/copy";
import { useToast } from "@/components/ui/toast";

export interface TrustedKeyItem {
  id: string;
  name: string;
  fingerprint: string;
  keyType: string;
  repositoryId: string | null;
  createdAt: string;
}

function RemoveKeyButton({ item }: { item: TrustedKeyItem }) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function confirm() {
    const data = new FormData();
    data.set("id", item.id);
    start(async () => {
      const res = await removeTrustedKeyAction(data);
      if (res.error) toast({ title: "Could not remove the key", description: res.error, tone: "error" });
      else toast({ title: `Removed key ${item.name}`, description: "Signatures in scope were re-verified." });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Remove key ${item.name}`}
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
        confirmLabel={busy ? "Removing…" : "Remove key"}
        title={`Remove key ${item.name}?`}
        description="Signatures made with this key stop verifying. Where signatures are required, images that carry no other trusted signature can no longer be pulled."
      />
    </>
  );
}

function KeyTable({ keys, scope, readOnly }: { keys: TrustedKeyItem[]; scope: "organization" | "repository"; readOnly?: boolean }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left">
          <th className="px-4 py-2 text-xs font-medium text-ink-2 sm:px-5">Name</th>
          <th className="px-4 py-2 text-xs font-medium text-ink-2">Fingerprint</th>
          <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 md:table-cell">Type</th>
          <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Scope</th>
          {!readOnly && <th className="w-10 px-2 py-2" aria-label="Actions" />}
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} className="border-b border-line last:border-0">
            <td className="px-4 py-2.5 font-medium sm:px-5">
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="size-3.5 text-ink-3" /> {k.name}
              </span>
            </td>
            <td className="px-4 py-2.5">
              <span className="inline-flex items-center gap-1 font-mono text-[13px] text-ink-2" title={`sha256:${k.fingerprint}`}>
                {k.fingerprint.slice(0, 16)}
                <CopyButton value={k.fingerprint} label="Copy fingerprint" />
              </span>
            </td>
            <td className="hidden px-4 py-2.5 text-xs text-ink-2 md:table-cell">{k.keyType || "—"}</td>
            <td className="hidden px-4 py-2.5 text-xs text-ink-2 sm:table-cell">
              {k.repositoryId ? "this repository" : scope === "repository" ? "organization-wide" : "every repository"}
            </td>
            {!readOnly && (
              <td className="px-2 py-1.5 text-right">
                <RemoveKeyButton item={k} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Trusted signing keys card: the public keys whose cosign signatures count
 * as verified, for an organization or one repository (which also lists the
 * organization-wide keys it inherits, read-only).
 */
export function TrustedKeysManager({
  scope,
  organizationId,
  repositoryId,
  keys,
  inherited = [],
}: {
  scope: "organization" | "repository";
  organizationId: string;
  repositoryId?: string;
  keys: TrustedKeyItem[];
  inherited?: TrustedKeyItem[];
}) {
  const [state, action, pending] = useActionState<SigningKeyResult | null, FormData>(addTrustedKeyAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.saved) {
      toast({ title: "Trusted key added", description: "Signatures in scope were re-verified." });
      formRef.current?.reset();
    }
  }, [state, toast]);

  return (
    <Card>
      <CardHeader
        eyebrow="Supply chain"
        title="Trusted signing keys"
        description={
          scope === "organization"
            ? "Public keys whose cosign signatures count as verified in every repository of the organization. Paste the PEM of a cosign.pub (ECDSA P-256/P-384, Ed25519 or RSA). Signatures are re-checked whenever a key is added or removed."
            : "Keys trusted for this repository only, on top of the organization-wide ones. Paste the PEM of a cosign.pub (ECDSA P-256/P-384, Ed25519 or RSA)."
        }
      />
      {keys.length > 0 ? (
        <div className="overflow-x-auto border-b border-line">
          <KeyTable keys={keys} scope={scope} />
        </div>
      ) : (
        <p className="border-b border-line px-4 py-3 text-sm text-ink-3 sm:px-5">
          No trusted keys yet. Generate one with <code className="font-mono">cosign generate-key-pair</code> and paste{" "}
          <code className="font-mono">cosign.pub</code> here.
        </p>
      )}
      <CardBody>
        <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-[minmax(10rem,1fr)_2fr_auto] sm:items-end">
          <input type="hidden" name="organizationId" value={organizationId} />
          {repositoryId && <input type="hidden" name="repositoryId" value={repositoryId} />}
          <Field label="Name" htmlFor={`key-name-${scope}`}>
            <Input id={`key-name-${scope}`} name="name" required placeholder="release" maxLength={80} />
          </Field>
          <Field label="Public key (PEM)" htmlFor={`key-pem-${scope}`}>
            <Textarea
              id={`key-pem-${scope}`}
              name="pem"
              required
              rows={3}
              className="font-mono text-xs"
              placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={pending} className="sm:mb-px">
            <Plus className="size-4" /> {pending ? "Adding…" : "Add key"}
          </Button>
          {state?.error && <p className="text-sm text-danger sm:col-span-3">{state.error}</p>}
        </form>
      </CardBody>
      {scope === "repository" && inherited.length > 0 && (
        <div className="border-t border-line">
          <div className="px-4 pt-3 sm:px-5">
            <div className="eyebrow">Inherited from the organization</div>
            <p className="mt-0.5 text-xs text-ink-3">Managed under Organization → Settings → Policies.</p>
          </div>
          <div className="overflow-x-auto">
            <KeyTable keys={inherited} scope="repository" readOnly />
          </div>
        </div>
      )}
    </Card>
  );
}
