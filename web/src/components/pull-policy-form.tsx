"use client";

import { useActionState, useState } from "react";
import { setOrgPullPolicy, setRepoPullPolicy, type PolicyResult } from "@/app/actions/pull-policy";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useActionToast } from "@/components/ui/toast";
import { describePolicy, type Level, type Policy } from "@/lib/pull-policy-shared";

const LEVEL_OPTIONS: { value: Level; label: string; description: string }[] = [
  { value: "critical", label: "Critical", description: "Block only images with critical findings" },
  { value: "high", label: "High and above", description: "Critical or high findings block the pull" },
  { value: "medium", label: "Medium and above", description: "Critical, high or medium" },
  { value: "low", label: "Low and above", description: "Any rated finding blocks the pull" },
];

/**
 * Pull policy card. For organizations the level applies to every repository;
 * repositories can inherit it, switch it off, or set their own.
 */
export function PullPolicyForm(
  props:
    | { scope: "organization"; organizationId: string; level: Level | null; unrated: boolean }
    | {
        scope: "repository";
        repositoryId: string;
        level: "off" | Level | null;
        unrated: boolean | null;
        inherited: Policy;
      },
) {
  const [state, action, pending] = useActionState<PolicyResult | null, FormData>(
    props.scope === "organization" ? setOrgPullPolicy : setRepoPullPolicy,
    null,
  );
  useActionToast(state, "Pull policy saved");
  const [level, setLevel] = useState<string>(props.level ?? "");
  const inherits = props.scope === "repository" && level === "";
  const off = level === "off" || (props.scope === "organization" && level === "");

  const options =
    props.scope === "organization"
      ? [{ value: "", label: "Off", description: "Pulls are never blocked by scan results" }, ...LEVEL_OPTIONS]
      : [
          {
            value: "",
            label: `Inherit from the organization (${describePolicy(props.inherited)})`,
            description: "Follow the organization-wide setting",
          },
          { value: "off", label: "Off", description: "Never block pulls of this repository" },
          ...LEVEL_OPTIONS,
        ];

  return (
    <Card>
      <CardHeader
        eyebrow="Pull policy"
        title="Block vulnerable images"
        description={
          props.scope === "organization"
            ? "Images whose last scan reports findings at or above the threshold cannot be pulled from any repository in this organization. Repositories may override it. Unscanned images are never blocked."
            : "Overrides the organization's threshold for this repository. Images whose last scan reports findings at or above the threshold cannot be pulled."
        }
      />
      <CardBody>
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          {props.scope === "organization" ? (
            <input type="hidden" name="organizationId" value={props.organizationId} />
          ) : (
            <input type="hidden" name="repositoryId" value={props.repositoryId} />
          )}
          <Field label="Block pulls at" htmlFor="pull-policy-level">
            <Select id="pull-policy-level" name="level" options={options} value={level} onChange={setLevel} />
          </Field>
          <label className="flex items-start gap-2 self-end pb-2 text-sm text-ink-2">
            <input
              type="checkbox"
              name="unrated"
              disabled={inherits || off}
              defaultChecked={props.scope === "organization" ? props.unrated : (props.unrated ?? props.inherited.unrated)}
              className="mt-0.5 size-4 accent-[var(--action)] disabled:opacity-50"
            />
            <span>
              Also block images with unrated findings
              <span className="block text-xs text-ink-3">
                Sources like Alpine publish fixes without severities; unrated is not harmless.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={pending}>
              Save policy
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
            {state?.saved && props.scope === "repository" && typeof state.blocked === "number" && (
              <span className="text-sm text-ink-2">
                {state.blocked === 0 ? "No images are blocked." : `${state.blocked} image${state.blocked === 1 ? "" : "s"} now blocked.`}
              </span>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
