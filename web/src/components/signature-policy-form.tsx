"use client";

import { useActionState, useEffect, useState } from "react";
import { setOrgSignaturePolicy, setRepoSignaturePolicy, type SignaturePolicyResult } from "@/app/actions/signature-policy";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useActionToast } from "@/components/ui/toast";

/**
 * "Require signatures" card. The organization switch applies to every
 * repository; a repository can inherit it, switch it on, or off — the same
 * tri-state as the vulnerability threshold.
 */
export function SignaturePolicyForm(
  props:
    | { scope: "organization"; organizationId: string; value: boolean; keyCount: number }
    | { scope: "repository"; repositoryId: string; value: boolean | null; inherited: boolean; keyCount: number },
) {
  const [state, action, pending] = useActionState<SignaturePolicyResult | null, FormData>(
    props.scope === "organization" ? setOrgSignaturePolicy : setRepoSignaturePolicy,
    null,
  );
  useActionToast(state, "Signature policy saved");
  const [mode, setMode] = useState<string>(props.scope === "repository" ? (props.value === null ? "" : props.value ? "on" : "off") : "");
  // Uncontrolled checkbox with the saved value as its default: React resets
  // the form when the action returns, and a controlled box would then show
  // the stale default until the next render (see MemberKeysPolicyForm).
  const orgValue = props.scope === "organization" ? props.value : false;
  const [checked, setChecked] = useState(orgValue);
  useEffect(() => setChecked(orgValue), [orgValue]);
  const effective = props.scope === "organization" ? checked : mode === "on" || (mode === "" && props.inherited);
  const noKeys = effective && props.keyCount === 0;

  return (
    <Card>
      <CardHeader
        eyebrow="Pull policy"
        title="Require signatures"
        description={
          props.scope === "organization"
            ? "Refuse pulls of images without a verified signature. Repositories can override this."
            : "Overrides the organization's setting. When on, images without a verified signature cannot be pulled."
        }
      />
      <CardBody>
        <form action={action} className="flex flex-wrap items-start gap-3">
          {props.scope === "organization" ? (
            <>
              <input type="hidden" name="organizationId" value={props.organizationId} />
              <FieldAction>
                <label className="flex items-center gap-2 py-2 text-sm text-ink">
                  <input
                    key={String(orgValue)}
                    type="checkbox"
                    name="requireSignature"
                    defaultChecked={orgValue}
                    onChange={(e) => setChecked(e.target.checked)}
                    className="size-4 accent-[var(--action)]"
                  />
                  Require a cosign signature from a trusted key
                </label>
              </FieldAction>
            </>
          ) : (
            <>
              <input type="hidden" name="repositoryId" value={props.repositoryId} />
              <div className="w-full sm:w-80">
                <Field label="Signatures" htmlFor="signature-policy-mode">
                  <Select
                    id="signature-policy-mode"
                    name="mode"
                    value={mode}
                    onChange={setMode}
                    options={[
                      {
                        value: "",
                        label: `Inherit from the organization (${props.inherited ? "required" : "not required"})`,
                        description: "Follow the organization-wide setting",
                      },
                      { value: "on", label: "Required", description: "Unsigned images cannot be pulled from this repository" },
                      { value: "off", label: "Not required", description: "Never block pulls of this repository for missing signatures" },
                    ]}
                  />
                </Field>
              </div>
            </>
          )}
          <FieldAction>
            <Button type="submit" disabled={pending}>
              Save policy
            </Button>
          </FieldAction>
          {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          {state?.saved && props.scope === "repository" && typeof state.blocked === "number" && (
            <span className="text-sm text-ink-2">
              {state.blocked === 0 ? "No images are blocked." : `${state.blocked} image${state.blocked === 1 ? "" : "s"} now blocked.`}
            </span>
          )}
          {noKeys && (
            <p className="basis-full text-xs text-danger">
              No trusted signing key is in scope: with the policy on, every image is blocked until a key is added below.
            </p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
