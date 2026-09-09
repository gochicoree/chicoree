"use client";

import { useActionState, useRef, useTransition } from "react";
import { createImport, previewMirror, type MirrorResult } from "@/app/actions/mirrors";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { MirrorFormFields } from "@/components/mirror-form-fields";

export function ImportForm({
  organizationId,
  orgSlug,
  requireCredentials = false,
}: {
  organizationId: string;
  orgSlug: string;
  /** This registry imports only with the member's own credentials for the source. */
  requireCredentials?: boolean;
}) {
  const [state, action, pending] = useActionState<MirrorResult | null, FormData>(createImport, null);
  const [preview, previewAction, previewing] = useActionState<MirrorResult | null, FormData>(previewMirror, null);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameTouched = useRef(false);
  const [, startTransition] = useTransition();

  // The destination name follows the source's last path segment until the
  // user edits it: "registry.example.com/team/app:1.2" → "app".
  function onInput(e: React.FormEvent<HTMLFormElement>) {
    const target = e.target as HTMLInputElement;
    if (target.id === "name") nameTouched.current = true;
    if (target.id === "source" && !nameTouched.current && nameRef.current) {
      nameRef.current.value = suggestName(target.value);
    }
  }

  // Invoking the actions ourselves (instead of <form action>) keeps React
  // from resetting every field once an action returns — a preview or a
  // validation error must not wipe what was typed.
  function run(act: (payload: FormData) => void) {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    startTransition(() => act(data));
  }

  return (
    <form
      ref={formRef}
      className="space-y-6"
      onInput={onInput}
      onSubmit={(e) => {
        e.preventDefault();
        run(action);
      }}
    >
      <input type="hidden" name="organizationId" value={organizationId} />
      <Card>
        <CardHeader
          eyebrow="Source"
          title="What to import"
          description={requireCredentials ? "Imports here run with your own account at the source registry, so its rate limit is yours." : undefined}
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <MirrorFormFields requireCredentials={requireCredentials} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" onClick={() => run(previewAction)} disabled={previewing}>
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
            <Field label="Repository name" htmlFor="name" hint={`Created as ${orgSlug === "library" ? "" : orgSlug + "/"}<name> if needed.`}>
              <Input ref={nameRef} id="name" name="name" required className="font-mono" pattern="[a-z0-9]+([._\\-][a-z0-9]+)*" />
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
            <Button type="submit" disabled={pending}>
              {pending ? "Starting import…" : "Create repository and import"}
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}

/** Repository name suggested from a source reference. */
export function suggestName(source: string): string {
  const last = source.trim().split("/").pop() ?? "";
  const bare = last.replace(/@sha256:.*$/, "").replace(/:[^:]*$/, "");
  return bare
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}
