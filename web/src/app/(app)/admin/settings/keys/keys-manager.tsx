"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { KeyRound, Plus, ShieldCheck, ShieldOff } from "lucide-react";
import { generateSigningKeyAction, retireSigningKeyAction, type KeyActionResult } from "@/app/actions/signing-keys";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { formatDate, relativeTime } from "@/lib/format";

export interface KeyView {
  kid: string;
  source: "database" | "file";
  algorithm: string;
  createdAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  /** When registryd stops trusting a retired key. */
  droppedAt: string | null;
  signs: boolean;
  /** null when the registry could not be asked. */
  trustedByRegistry: boolean | null;
  dropped: boolean;
  /** File key only. */
  path?: string;
  error?: string | null;
}

function useResultToast(state: KeyActionResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message });
  }, [state, toast]);
}

function GenerateButton() {
  const [state, action, pending] = useActionState<KeyActionResult | null, FormData>(generateSigningKeyAction, null);
  useResultToast(state);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" size="sm" disabled={pending} data-generate-key>
        <Plus className="size-3.5" /> {pending ? "Generating…" : "Generate new key"}
      </Button>
      {state?.error && <span className="text-sm text-danger">{state.error}</span>}
    </form>
  );
}

function RetireButton({ k }: { k: KeyView }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<KeyActionResult | null, FormData>(retireSigningKeyAction, null);
  useResultToast(state);
  useEffect(() => {
    if (state?.message && !state.error) setOpen(false);
  }, [state]);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} data-retire-key={k.kid}>
        <ShieldOff className="size-3.5" /> Retire
      </Button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          const fd = new FormData();
          fd.set("kid", k.kid);
          action(fd);
        }}
        title="Retire this key?"
        description="Tokens already signed with it stay valid for their remaining lifetime (up to five minutes); the registry drops the key ten minutes after retirement. Make sure the new key has been signing for longer than five minutes."
        confirmLabel={pending ? "Retiring…" : "Retire key"}
        tone="danger"
        busy={pending}
      >
        <p className="break-all font-mono text-xs text-ink-2">{k.kid}</p>
        {state?.error && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
      </ConfirmModal>
    </>
  );
}

function StateBadges({ k }: { k: KeyView }) {
  return (
    <>
      {k.signs && <Badge tone="accent">signs now</Badge>}
      {!k.signs && !k.retiredAt && <Badge tone="ok">verifying</Badge>}
      {k.retiredAt && !k.dropped && <Badge tone="neutral">retired · dropped {relativeTime(k.droppedAt)}</Badge>}
      {k.dropped && <Badge tone="neutral">retired · no longer trusted</Badge>}
      {k.trustedByRegistry === true && (
        <Badge tone="ok" title="The registry verifies tokens with this key right now">
          <ShieldCheck className="size-3" /> registry trusts it
        </Badge>
      )}
      {k.trustedByRegistry === false && !k.dropped && (
        <Badge tone="danger" title="The registry has not loaded this key (it reloads every 60 s)">
          not yet trusted by registry
        </Badge>
      )}
    </>
  );
}

export function KeysManager({
  keys,
  signerError,
  registryReachable,
  registryAuthDisabled,
}: {
  keys: KeyView[];
  signerError: string | null;
  registryReachable: boolean;
  registryAuthDisabled: boolean;
}) {
  const dbKeys = keys.filter((k) => k.source === "database");
  const fileKey = keys.find((k) => k.source === "file");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Registry tokens"
          title="Signing keys"
          description="The newest active key signs every registry token (its id travels in the JWT header). The registry verifies against the file key and every database key that is not retired, and re-reads this list every 60 seconds — or immediately when a token names a key it does not know."
          action={<GenerateButton />}
        />
        {signerError && (
          <CardBody>
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">No usable signing key: {signerError}</p>
          </CardBody>
        )}
        {!registryReachable && (
          <CardBody>
            <p className="text-sm text-ink-3">The registry could not be reached, so which keys it trusts is unknown.</p>
          </CardBody>
        )}
        {registryAuthDisabled && (
          <CardBody>
            <p className="text-sm text-ink-3">The registry runs with AUTH_DISABLED and does not verify tokens.</p>
          </CardBody>
        )}
        <div>
          {dbKeys.length === 0 && (
            <p className="px-4 py-3 text-sm text-ink-3 sm:px-5">No database keys yet — the file key below signs and verifies. Generate a key to start rotating from the panel.</p>
          )}
          {dbKeys.map((k) => (
            <div key={k.kid} data-key-row={k.kid} className={`flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5 ${k.dropped ? "opacity-60" : ""}`}>
              <KeyRound className="size-4 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{k.kid.slice(0, 16)}</span>
                  <Badge>{k.algorithm}</Badge>
                  <StateBadges k={k} />
                </div>
                <div className="mt-0.5 break-all font-mono text-xs text-ink-3">{k.kid}</div>
                <div className="mt-0.5 text-xs text-ink-2">
                  created {formatDate(k.createdAt)}
                  {k.activatedAt && ` · activated ${formatDate(k.activatedAt)}`}
                  {k.retiredAt && ` · retired ${formatDate(k.retiredAt)}`}
                </div>
              </div>
              {!k.signs && !k.retiredAt && <RetireButton k={k} />}
            </div>
          ))}
          {fileKey && (
            <div data-key-row="file" className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <KeyRound className="size-4 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{fileKey.kid ? fileKey.kid.slice(0, 16) : "file key"}</span>
                  <Badge tone="info">file key</Badge>
                  <Badge>{fileKey.algorithm}</Badge>
                  {fileKey.error ? <Badge tone="danger">unreadable</Badge> : <StateBadges k={fileKey} />}
                </div>
                <div className="mt-0.5 break-all font-mono text-xs text-ink-3">{fileKey.error ? fileKey.error : fileKey.kid}</div>
                <div className="mt-0.5 break-words text-xs text-ink-2">
                  JWT_PRIVATE_KEY_FILE = <span className="break-all font-mono">{fileKey.path}</span> · always trusted by the registry (JWT_PUBLIC_KEY_FILE); signs only while no database key is active
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Procedure" title="Rotating a key" />
        <CardBody>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
            <li>
              <span className="font-medium text-ink">Generate new key.</span> It signs immediately; the registry learns about it within 60 seconds (sooner when a token with the new id arrives), and the previous key keeps verifying.
            </li>
            <li>
              <span className="font-medium text-ink">Wait longer than five minutes</span> — the lifetime of a registry token. Every token signed with the old key has expired by then. The Health page shows whether the registry trusts the active key.
            </li>
            <li>
              <span className="font-medium text-ink">Retire the old key.</span> Retiring is refused for the key that signs right now. Ten minutes after retirement the registry drops the key; tokens signed with it are rejected from then on.
            </li>
          </ol>
          <p className="mt-3 text-xs text-ink-3">
            Private keys are stored AES-GCM encrypted under a key derived from AUTH_SECRET, so the database alone cannot sign tokens. Changing AUTH_SECRET makes stored keys unusable: the app then falls back to the file key.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
