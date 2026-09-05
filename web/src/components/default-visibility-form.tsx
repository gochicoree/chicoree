"use client";

import { useActionState } from "react";
import { setOrgDefaultVisibility, setUserDefaultVisibility, type SettingsResult } from "@/app/actions/settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useActionToast } from "@/components/ui/toast";

export function DefaultVisibilityForm({
  scope,
  organizationId,
  value,
}: {
  scope: "organization" | "user";
  organizationId?: string;
  value: "public" | "private" | null;
}) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(
    scope === "organization" ? setOrgDefaultVisibility : setUserDefaultVisibility,
    null,
  );
  useActionToast(state, "Default visibility saved");
  const options =
    scope === "organization"
      ? [
          { value: "", label: "Inherit from the pusher", description: "Use the pushing user's default, or private" },
          { value: "private", label: "Private", description: "Members only" },
          { value: "public", label: "Public", description: "Anyone can pull, counts against the public limit" },
        ]
      : [
          { value: "", label: "Private (default)", description: "Members only" },
          { value: "private", label: "Private", description: "Members only" },
          { value: "public", label: "Public", description: "Anyone can pull, counts against the public limit" },
        ];

  return (
    <Card>
      <CardHeader
        eyebrow="Pushes"
        title="Default visibility for new repositories"
        description={
          scope === "organization"
            ? "For repositories created by pushing to a new name."
            : "For repositories you create by pushing, unless the organization has its own default."
        }
      />
      <CardBody>
        <form action={action} className="flex flex-wrap items-start gap-3">
          {organizationId && <input type="hidden" name="organizationId" value={organizationId} />}
          <div className="w-full sm:w-72">
            <Field label="New repositories are" htmlFor="defaultVisibility">
              <Select id="defaultVisibility" name="defaultVisibility" options={options} defaultValue={value ?? ""} />
            </Field>
          </div>
          <FieldAction>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </FieldAction>
          {state?.error && <span className="text-sm text-danger">{state.error}</span>}
        </form>
      </CardBody>
    </Card>
  );
}
