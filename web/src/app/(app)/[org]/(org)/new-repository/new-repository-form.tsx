"use client";

import { useActionState } from "react";
import { createRepository, type ActionResult } from "@/app/actions/repositories";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

export function NewRepositoryForm({
  organizationId,
  orgSlug,
  defaultVisibility,
}: {
  organizationId: string;
  orgSlug: string;
  defaultVisibility: "public" | "private";
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createRepository,
    null,
  );

  return (
    <Card>
      <CardBody>
        <form action={action} className="space-y-4">
          <input type="hidden" name="organizationId" value={organizationId} />
          <Field label="Name" htmlFor="name" hint={`Pushed as <registry>/${orgSlug}/<name>.`}>
            <Input
              id="name"
              name="name"
              required
              className="font-mono"
              pattern="[a-z0-9]+([._\\-][a-z0-9]+)*"
              placeholder="api-server"
            />
          </Field>
          <Field label="Description" htmlFor="description">
            <Textarea id="description" name="description" placeholder="What lives in this repository?" />
          </Field>
          <Field
            label="Visibility"
            htmlFor="visibility"
            hint="Public repositories can be pulled by anyone, even without an account."
          >
            <Select
              id="visibility"
              name="visibility"
              defaultValue={defaultVisibility}
              options={[
                { value: "private", label: "Private", description: "Members and viewers only" },
                { value: "public", label: "Public", description: "Anonymous pulls allowed" },
              ]}
            />
          </Field>
          {state?.error && (
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>
          )}
          <Button type="submit" disabled={pending}>
            Create repository
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
