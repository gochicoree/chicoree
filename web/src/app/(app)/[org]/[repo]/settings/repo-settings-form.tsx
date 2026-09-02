"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import { deleteRepository, updateRepository, type ActionResult } from "@/app/actions/repositories";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { useActionToast } from "@/components/ui/toast";

export function RepoSettingsForm({
  repositoryId,
  name,
  description,
  visibility: initialVisibility,
  children,
}: {
  repositoryId: string;
  name: string;
  description: string;
  visibility: string;
  /** Further settings cards (webhooks, mirror), rendered above the danger zone. */
  children?: ReactNode;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateRepository, null);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [confirm, setConfirm] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useActionToast(state, "Repository settings saved");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // Going public is a one-click way to expose private content: confirm first.
    if (visibility === "public" && initialVisibility !== "public" && !confirmPublic) {
      e.preventDefault();
      setConfirmPublic(true);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader eyebrow="Repository" title={`Settings — ${name}`} />
        <CardBody>
          <form ref={formRef} action={action} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="repositoryId" value={repositoryId} />
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="description">
                <Textarea id="description" name="description" defaultValue={description} />
              </Field>
            </div>
            <Field label="Visibility" htmlFor="visibility" hint="Public repositories can be pulled by anyone without credentials.">
              <Select
                id="visibility"
                name="visibility"
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: "private", label: "Private", description: "Members and viewers only" },
                  { value: "public", label: "Public", description: "Anonymous pulls allowed" },
                ]}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={pending}>
                Save changes
              </Button>
              {state?.error && <span className="text-sm text-danger">{state.error}</span>}
            </div>
          </form>
        </CardBody>
      </Card>

      <ConfirmModal
        open={confirmPublic}
        onClose={() => setConfirmPublic(false)}
        onConfirm={() => {
          setConfirmPublic(false);
          formRef.current?.requestSubmit();
        }}
        title={`Make ${name} public?`}
        description="Anyone on the internet will be able to pull every tag in this repository without signing in, and it will be listed on the Explore page. It also counts against the organization's public repository limit."
        confirmLabel="Yes, make it public"
        tone="accent"
      />

      {children}

      <Card className="border-danger/30">
        <CardHeader
          eyebrow="Danger"
          title="Delete this repository"
          description="Removes every tag, manifest and pull statistic. Layer content shared with other repositories is kept; unique content is reclaimed by garbage collection."
        />
        <CardBody>
          <form action={deleteRepository} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="repositoryId" value={repositoryId} />
            <div className="min-w-64">
              <Field label={`Type "${name}" to confirm`} htmlFor="confirmName">
                <Input id="confirmName" name="confirmName" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />
              </Field>
            </div>
            <Button type="submit" variant="danger" disabled={confirm !== name}>
              Delete repository permanently
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
