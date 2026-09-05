"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { addUserSigningKeyAction, removeUserSigningKeyAction, type UserSigningKeyResult } from "@/app/actions/user-signing-keys";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { ConfirmModal } from "@/components/ui/modal";
import { CommandLine, CopyButton } from "@/components/ui/copy";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { relativeTime } from "@/lib/format";

export interface PersonalKeyItem {
  id: string;
  name: string;
  fingerprint: string;
  keyType: string;
  createdAt: string;
}

export interface TrustingOrg {
  slug: string;
  name: string;
  role: string;
  /** false when the organization switched members' keys off. */
  trusted: boolean;
}

function RemoveButton({ item }: { item: PersonalKeyItem }) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function confirm() {
    const data = new FormData();
    data.set("id", item.id);
    start(async () => {
      const res = await removeUserSigningKeyAction(data);
      if (res.error) toast({ title: "Could not remove the key", description: res.error, tone: "error" });
      else toast({ title: `Removed key ${item.name}`, description: "Signatures made with it are being re-verified." });
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
        description="Signatures you made with this key stop verifying. Where signatures are required, images that carry no other trusted signature can no longer be pulled."
      />
    </>
  );
}

/**
 * Settings → Signing keys: the cosign public keys that belong to this
 * account. Signatures made with them verify wherever the account may push.
 */
export function SigningKeysManager({
  registryHost,
  keys,
  organizations,
  instanceAdmin,
}: {
  registryHost: string;
  keys: PersonalKeyItem[];
  organizations: TrustingOrg[];
  instanceAdmin: boolean;
}) {
  const [state, action, pending] = useActionState<UserSigningKeyResult | null, FormData>(addUserSigningKeyAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.saved) {
      toast({ title: "Signing key added", description: "Your signatures are being re-verified in the background." });
      formRef.current?.reset();
    }
  }, [state, toast]);
  const trusting = organizations.filter((o) => o.trusted);
  const optedOut = organizations.filter((o) => !o.trusted);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Supply chain"
          title="Personal signing keys"
          description="The cosign public keys that belong to you. A signature or attestation made with one of them counts as verified in every repository you may push to — as long as that organization trusts members' keys. A public key can belong to one account only."
        />
        {keys.length > 0 ? (
          <div className="overflow-x-auto border-b border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2 text-xs font-medium text-ink-2 sm:px-5">Name</th>
                  <th className="px-4 py-2 text-xs font-medium text-ink-2">Fingerprint</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 md:table-cell">Type</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Added</th>
                  <th className="w-10 px-2 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} data-personal-key className="border-b border-line last:border-0">
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
                    <td className="hidden px-4 py-2.5 text-xs text-ink-2 sm:table-cell">{relativeTime(k.createdAt)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <RemoveButton item={k} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-b border-line px-4 py-3 text-sm text-ink-3 sm:px-5">
            No personal keys yet. Generate one with <code className="font-mono">cosign generate-key-pair</code> and paste{" "}
            <code className="font-mono">cosign.pub</code> below.
          </p>
        )}
        <CardBody>
          <form ref={formRef} action={action} className="flex flex-col gap-3">
            <div className="sm:max-w-xs">
              <Field label="Name" htmlFor="personal-key-name" hint="Shown next to your verified signatures, e.g. “laptop” or “yubikey”.">
                <Input id="personal-key-name" name="name" required placeholder="laptop" maxLength={80} />
              </Field>
            </div>
            <Field label="Public key (PEM)" htmlFor="personal-key-pem">
              <Textarea
                id="personal-key-pem"
                name="pem"
                required
                rows={3}
                className="font-mono text-xs"
                placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="secondary" disabled={pending}>
                <Plus className="size-4" /> {pending ? "Adding…" : "Add key"}
              </Button>
              {state?.error && <p className="text-sm text-danger">{state.error}</p>}
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Where they count"
          title={instanceAdmin ? "Every organization" : "Organizations you may push to"}
          description={
            instanceAdmin
              ? "Instance administrators may push everywhere, so their keys verify in every organization that trusts members' keys."
              : "Owners, admins and members may push; viewers' keys never count. Losing the role stops the key from verifying at the next check."
          }
        />
        <CardBody className="space-y-3 text-sm">
          {organizations.length === 0 ? (
            <p className="text-ink-3">You are not a writer in any organization yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {organizations.map((o) => (
                <li key={o.slug}>
                  <Link
                    href={`/${o.slug}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 hover:bg-card-2"
                    title={o.trusted ? `${o.role} — your keys are trusted here` : `${o.role} — this organization only trusts its own keys`}
                  >
                    {o.name}
                    <Badge tone={o.trusted ? "ok" : "neutral"}>{o.trusted ? "trusted" : "own keys only"}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {optedOut.length > 0 && trusting.length > 0 && (
            <p className="text-xs text-ink-3">
              Organizations marked “own keys only” switched members&apos; keys off under Settings → Policies; their owners can add your key
              as a trusted key instead.
            </p>
          )}
          <div className="space-y-2 pt-1">
            <p className="text-ink-2">Sign an image, or attach an SBOM as a signed attestation, with your private key:</p>
            <CommandLine command={`cosign sign --key cosign.key ${registryHost}/<org>/<image>@sha256:…`} />
            <CommandLine command={`cosign attest --key cosign.key --type spdxjson --predicate sbom.spdx.json ${registryHost}/<org>/<image>@sha256:…`} />
            <p className="text-xs text-ink-3">
              Sign by digest, not by tag. cosign v3 needs <code className="font-mono">--use-signing-config=false --tlog-upload=false</code> for a
              private key without the public transparency log.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
