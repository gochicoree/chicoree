"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameOrganization } from "@/app/actions/repo-tools";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction, Input } from "@/components/ui/field";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ORG_SLUG_RE } from "@/lib/repo-names-shared";

/** Change the organization slug (its image namespace); owners only. */
export function OrgRenameForm({
  organizationId,
  slug,
  registryHost,
  formerSlugs,
}: {
  organizationId: string;
  slug: string;
  registryHost: string;
  formerSlugs: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = useState(slug);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const next = value.trim().toLowerCase();
  const valid = ORG_SLUG_RE.test(next);
  const ready = next !== slug && valid;

  function confirm() {
    const data = new FormData();
    data.set("organizationId", organizationId);
    data.set("slug", next);
    start(async () => {
      const res = await renameOrganization(data);
      if (res.error || !res.href) {
        setError(res.error ?? "Could not rename the organization.");
        setOpen(false);
        return;
      }
      toast({ title: `Slug changed to ${next}`, description: `Images are now ${res.pullReference}. The old slug keeps working for pulls.` });
      setOpen(false);
      router.push(res.href);
      router.refresh();
    });
  }

  return (
    <>
      <Card className="border-danger/30">
        <CardHeader
          eyebrow="Rename"
          title="Change the organization slug"
          description="The slug is the image namespace. Pulls of the old namespace are redirected; pushes to it are refused. Web links to the old slug redirect."
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-64 flex-1 sm:flex-none">
              <Field label="New slug" htmlFor="rename-slug" hint={`Images will be pulled as ${registryHost}/${next || "<slug>"}/<repository>:<tag>`}>
                <Input
                  id="rename-slug"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                  className="font-mono"
                  autoComplete="off"
                />
              </Field>
            </div>
            <FieldAction>
              <Button type="button" variant="danger" disabled={!ready || busy} onClick={() => setOpen(true)}>
                Rename…
              </Button>
            </FieldAction>
          </div>
          {next && !valid && <p className="text-sm text-danger">Slugs use lowercase letters, digits and single ._- separators.</p>}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {formerSlugs.length > 0 && (
            <p className="text-xs text-ink-2">
              Former slugs still redirecting here: <span className="font-mono">{formerSlugs.join(", ")}</span>. Creating an organization with one of them ends its redirect.
            </p>
          )}
        </CardBody>
      </Card>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Renaming…" : `Rename to ${next}`}
        title={`Rename ${slug} to ${next}?`}
        description="What changes:"
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>
            New references: <code className="font-mono text-ink">docker pull {registryHost}/{next}/&lt;repository&gt;:&lt;tag&gt;</code>
          </li>
          <li>
            <code className="font-mono">{registryHost}/{slug}/…</code> keeps working for <strong>pulls</strong> through a redirect; pushes and deletes against the old namespace are refused with the new name.
          </li>
          <li>Every web address under /{slug} redirects to /{next}.</li>
          <li>Members, repositories, service accounts, webhooks, rules and policies are unchanged. CI pipelines pushing to the old namespace must be updated.</li>
          <li>The old slug becomes free again as soon as a new organization is created with it.</li>
        </ul>
      </ConfirmModal>
    </>
  );
}
