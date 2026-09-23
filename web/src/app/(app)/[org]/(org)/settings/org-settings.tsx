"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

export function OrgGeneralForm({
  organizationId,
  name: initialName,
  slug,
  isLibrary = false,
}: {
  organizationId: string;
  name: string;
  slug: string;
  isLibrary?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.organization.update({ organizationId, data: { name } });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not save");
    else {
      toast({ title: "Organization saved" });
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader eyebrow="General" title="Organization details" />
      <CardBody>
        <form onSubmit={save} className="space-y-4">
          <Field label="Name" htmlFor="org-name">
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {isLibrary && (
            <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent-ink">
              This is the library organization: it owns top-level image names (registry/nginx) and cannot be deleted.
            </p>
          )}
          <Field
            label="Slug"
            htmlFor="org-slug"
            hint="Part of every image name; use Rename to change it."
          >
            <Input id="org-slug" value={slug} disabled className="font-mono" />
          </Field>
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={busy}>
            Save changes
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

/** Delete behind a dialog that asks for the organization slug. */
export function OrgDeleteForm({ organizationId, slug }: { organizationId: string; slug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function destroy() {
    setBusy(true);
    setError(null);
    const res = await authClient.organization.delete({ organizationId });
    setBusy(false);
    setOpen(false);
    if (res.error) setError(res.error.message ?? "Could not delete the organization");
    else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <Card className="border-danger/30">
      <CardHeader
        eyebrow="Danger"
        title="Delete this organization"
        description="Deletes the organization and every repository in it. This cannot be undone."
      />
      <CardBody className="space-y-3">
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="button" variant="danger" disabled={busy} onClick={() => setOpen(true)}>
          <Trash2 className="size-4" /> Delete organization…
        </Button>
      </CardBody>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={destroy}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Deleting…" : "Delete organization"}
        confirmText={slug}
        title={`Delete ${slug}?`}
        description="The organization and every repository in it are deleted, with their tags and images. This cannot be undone."
      />
    </Card>
  );
}
