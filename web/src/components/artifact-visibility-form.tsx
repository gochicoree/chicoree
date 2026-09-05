"use client";

import { useActionState } from "react";
import { setUserShowArtifacts, type SettingsResult } from "@/app/actions/settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useActionToast } from "@/components/ui/toast";

/** Per-user override of the instance switch for listing supply-chain artifacts next to images. */
export function ArtifactVisibilityForm({ value, instanceDefault }: { value: boolean | null; instanceDefault: boolean }) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(setUserShowArtifacts, null);
  useActionToast(state, "Display setting saved");
  const options = [
    { value: "", label: `Instance default (${instanceDefault ? "shown" : "hidden"})`, description: "Whatever the administrator chose" },
    { value: "show", label: "Show", description: "List them with the images" },
    { value: "hide", label: "Hide", description: "Keep them out of lists; the Attestations tab still has them" },
  ];
  return (
    <Card>
      <div id="display" />
      <CardHeader
        eyebrow="Display"
        title="Signatures, SBOMs and attestation entries"
        description="Whether cosign tags, attached artifacts and the unknown/unknown entries docker buildx adds to an index appear in tag lists, the untagged list and variants tables."
      />
      <CardBody>
        <form action={action} className="flex flex-wrap items-start gap-3">
          <div className="w-full sm:w-72">
            <Field label="In lists, artifacts are" htmlFor="showArtifacts">
              <Select id="showArtifacts" name="showArtifacts" options={options} defaultValue={value === null ? "" : value ? "show" : "hide"} />
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
