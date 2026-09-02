"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

export function OrgSettings({
  organizationId,
  name: initialName,
  slug,
  isOwner,
  isLibrary = false,
}: {
  organizationId: string;
  name: string;
  slug: string;
  isOwner: boolean;
  isLibrary?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await authClient.organization.update({
      organizationId,
      data: { name },
    });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not save");
    else {
      setSaved(true);
      router.refresh();
    }
  }

  async function destroy() {
    setBusy(true);
    setError(null);
    const res = await authClient.organization.delete({ organizationId });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not delete the organization");
    else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
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
              hint="The slug is the image namespace and cannot be changed — existing image references would break."
            >
              <Input id="org-slug" value={slug} disabled className="font-mono" />
            </Field>
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            {saved && <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">Saved.</p>}
            <Button type="submit" disabled={busy}>
              Save changes
            </Button>
          </form>
        </CardBody>
      </Card>

      {isOwner && (
        <Card className="border-danger/30">
          <CardHeader
            eyebrow="Danger"
            title="Delete this organization"
            description="Removes the organization, every repository in it, and all image metadata. Blob content is reclaimed by the next garbage-collection run. This cannot be undone."
          />
          <CardBody className="space-y-3">
            <Field label={`Type "${slug}" to confirm`} htmlFor="confirm-slug">
              <Input
                id="confirm-slug"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Button variant="danger" disabled={busy || confirm !== slug} onClick={destroy}>
              Delete organization permanently
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
