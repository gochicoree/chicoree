"use client";

import { useActionState, useRef, useState } from "react";
import { deleteRepository, updateRepository, type ActionResult } from "@/app/actions/repositories";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { useActionToast } from "@/components/ui/toast";

/** Description and visibility. */
export function RepoGeneralForm({
  repositoryId,
  name,
  description,
  visibility: initialVisibility,
}: {
  repositoryId: string;
  name: string;
  description: string;
  visibility: string;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateRepository, null);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [confirmPublic, setConfirmPublic] = useState(false);
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
    <>
      <Card>
        <CardHeader eyebrow="General" title="Repository details" />
        <CardBody>
          <form ref={formRef} action={action} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="repositoryId" value={repositoryId} />
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="description">
                <Textarea id="description" name="description" defaultValue={description} />
              </Field>
            </div>
            <Field label="Visibility" htmlFor="visibility" hint="Public repositories can be pulled by anyone.">
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
        description="Anyone will be able to pull this repository without signing in, and it will appear on the Explore page."
        confirmLabel="Yes, make it public"
        tone="accent"
      />
    </>
  );
}

/** Typed-confirmation delete. */
export function RepoDangerForm({ repositoryId, name }: { repositoryId: string; name: string }) {
  const [confirm, setConfirm] = useState("");
  return (
    <Card className="border-danger/30">
      <CardHeader
        eyebrow="Danger"
        title="Delete this repository"
        description="Deletes every tag and image in this repository. This cannot be undone."
      />
      <CardBody>
        <form action={deleteRepository} className="flex flex-wrap items-start gap-3">
          <input type="hidden" name="repositoryId" value={repositoryId} />
          <div className="min-w-64">
            <Field label={`Type "${name}" to confirm`} htmlFor="confirmName">
              <Input id="confirmName" name="confirmName" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />
            </Field>
          </div>
          <FieldAction>
            <Button type="submit" variant="danger" disabled={confirm !== name}>
              Delete repository permanently
            </Button>
          </FieldAction>
        </form>
      </CardBody>
    </Card>
  );
}
