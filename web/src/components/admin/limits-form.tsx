"use client";

import { useActionState } from "react";
import { setOrgLimits, setUserLimits, type LimitsActionResult } from "@/app/actions/limits";
import type { Limits } from "@/lib/quota";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useActionToast } from "@/components/ui/toast";

/** Admin form for per-user or per-organization limits. Empty = unlimited. */
export function LimitsForm({
  scope,
  targetId,
  limits,
  note,
}: {
  scope: "user" | "organization";
  targetId: string;
  limits: Limits;
  note: string;
}) {
  const [state, action, pending] = useActionState<LimitsActionResult | null, FormData>(
    scope === "user" ? setUserLimits : setOrgLimits,
    null,
  );
  useActionToast(state, "Limits saved");
  const gib = limits.maxStorageBytes === null ? "" : String(limits.maxStorageBytes / 1024 ** 3);

  return (
    <Card>
      <CardHeader
        eyebrow="Limits"
        title={scope === "user" ? "Account limits" : "Organization limits"}
        description={
          scope === "user"
            ? "Caps for everything this user owns, summed across organizations where they are an owner. Leave a field empty for no limit."
            : "Caps for this organization. Owner-level account limits apply on top. Leave a field empty for no limit."
        }
      />
      <CardBody>
        <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name={scope === "user" ? "userId" : "organizationId"} value={targetId} />
          {scope === "user" && (
            <Field label="Organizations" htmlFor="maxOrganizations" hint="They can create">
              <Input
                id="maxOrganizations"
                name="maxOrganizations"
                type="number"
                min={0}
                placeholder="unlimited"
                defaultValue={limits.maxOrganizations ?? ""}
              />
            </Field>
          )}
          <Field label="Public repositories" htmlFor="maxPublicRepos">
            <Input
              id="maxPublicRepos"
              name="maxPublicRepos"
              type="number"
              min={0}
              placeholder="unlimited"
              defaultValue={limits.maxPublicRepos ?? ""}
            />
          </Field>
          <Field label="Private repositories" htmlFor="maxPrivateRepos">
            <Input
              id="maxPrivateRepos"
              name="maxPrivateRepos"
              type="number"
              min={0}
              placeholder="unlimited"
              defaultValue={limits.maxPrivateRepos ?? ""}
            />
          </Field>
          <Field label="Storage (GiB)" htmlFor="maxStorageGiB" hint="Deduplicated bytes">
            <Input
              id="maxStorageGiB"
              name="maxStorageGiB"
              type="number"
              min={0}
              step="0.1"
              placeholder="unlimited"
              defaultValue={gib}
            />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Note" htmlFor="limits-note" hint="Internal, shown only to admins">
              <Input id="limits-note" name="note" defaultValue={note} placeholder="e.g. free tier" />
            </Field>
          </div>
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={pending}>
              Save limits
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
