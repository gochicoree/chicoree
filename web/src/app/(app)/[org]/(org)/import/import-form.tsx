"use client";

import { useActionState } from "react";
import { createImport, previewMirror, type MirrorResult } from "@/app/actions/mirrors";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { MirrorFormFields } from "@/components/mirror-form-fields";

export function ImportForm({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  const [state, action, pending] = useActionState<MirrorResult | null, FormData>(createImport, null);
  const [preview, previewAction, previewing] = useActionState<MirrorResult | null, FormData>(previewMirror, null);

  return (
    <form className="space-y-6">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Card>
        <CardHeader eyebrow="Source" title="What to import" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <MirrorFormFields />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" formAction={previewAction} formNoValidate disabled={previewing}>
              {previewing ? "Checking…" : "Preview matching tags"}
            </Button>
            {preview?.error && <span className="text-sm text-danger">{preview.error}</span>}
            {preview?.preview && (
              <span className="text-sm text-ink-2">
                {preview.preview.matched.length} of {preview.preview.total} tags match
              </span>
            )}
          </div>
          {preview?.preview && preview.preview.matched.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {preview.preview.matched.map((t) => (
                <span key={t} className="rounded-md bg-card-2 px-2 py-0.5 font-mono text-xs">
                  {t}
                </span>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Destination" title="Where it goes" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Repository name" htmlFor="name" hint={`Created as ${orgSlug === "library" ? "" : orgSlug + "/"}<name> if it doesn't exist.`}>
              <Input id="name" name="name" required className="font-mono" pattern="[a-z0-9]+([._\\-][a-z0-9]+)*" />
            </Field>
            <Field label="Visibility" htmlFor="visibility">
              <Select
                id="visibility"
                name="visibility"
                defaultValue="private"
                options={[
                  { value: "private", label: "Private", description: "Members only" },
                  { value: "public", label: "Public", description: "Anyone can pull" },
                ]}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2">
              <input type="checkbox" name="overwrite" defaultChecked className="size-4 accent-[var(--action)]" />
              Re-import tags whose upstream content changed (keeps mutable tags like <code className="font-mono">latest</code> fresh)
            </label>
          </div>
          {state?.error && <p className="mt-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
          <div className="mt-4">
            <Button type="submit" formAction={action} disabled={pending}>
              {pending ? "Starting import…" : "Create repository and import"}
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
