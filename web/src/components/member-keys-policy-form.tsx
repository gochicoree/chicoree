"use client";

import { useActionState, useEffect, useState } from "react";
import { setOrgMemberKeysPolicy, type SignaturePolicyResult } from "@/app/actions/signature-policy";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldAction } from "@/components/ui/field";
import { useActionToast } from "@/components/ui/toast";

/**
 * "Members' signing keys" card: whether personal keys registered by members
 * who may push (Settings → Signing keys) count as trusted in this
 * organization, next to the keys the organization trusts explicitly.
 */
export function MemberKeysPolicyForm({ organizationId, value, memberKeyCount }: { organizationId: string; value: boolean; memberKeyCount: number }) {
  const [state, action, pending] = useActionState<SignaturePolicyResult | null, FormData>(setOrgMemberKeysPolicy, null);
  useActionToast(state, "Members' keys policy saved");
  // React resets the form once the action returns, which puts an
  // uncontrolled checkbox back to its default — so the default *is* the
  // saved value (keyed, to remount when the server sends a new one), and
  // the state only drives the hint text.
  const [checked, setChecked] = useState(value);
  useEffect(() => setChecked(value), [value]);

  return (
    <Card>
      <CardHeader
        eyebrow="Supply chain"
        title="Members' signing keys"
        description="Accept signatures made with the personal keys of members who can push. Switch it off to accept only the trusted keys below."
      />
      <CardBody>
        <form action={action} className="flex flex-wrap items-start gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <FieldAction>
            <label className="flex items-center gap-2 py-2 text-sm text-ink">
              <input
                key={String(value)}
                type="checkbox"
                name="trustMemberKeys"
                defaultChecked={value}
                onChange={(e) => setChecked(e.target.checked)}
                className="size-4 accent-[var(--action)]"
              />
              Trust the personal keys of members who may push
            </label>
          </FieldAction>
          <FieldAction>
            <Button type="submit" disabled={pending}>
              Save policy
            </Button>
          </FieldAction>
          {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          <p className="basis-full text-xs text-ink-3">
            {memberKeyCount === 0
              ? "No member has registered a personal key yet."
              : `${memberKeyCount} personal key${memberKeyCount === 1 ? "" : "s"} registered${checked ? "" : " (ignored while this is off)"}.`}{" "}
            Signatures are re-verified when the setting changes; a member who loses push access stops verifying at the next check.
          </p>
        </form>
      </CardBody>
    </Card>
  );
}
