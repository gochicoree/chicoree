"use client";

import { useRef, useState } from "react";
import { adminDeleteOrganization, adminSetMemberRole } from "@/app/actions/admin-orgs";
import { ORG_ROLE_NAMES } from "@/lib/org-roles";
import { Input, Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CardBody } from "@/components/ui/card";

/** Role dropdown that submits its form on change. */
export function MemberRoleSelect({
  memberId,
  organizationId,
  role,
}: {
  memberId: string;
  organizationId: string;
  role: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={adminSetMemberRole}>
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="organizationId" value={organizationId} />
      <Select
        name="role"
        defaultValue={role}
        onChange={() => requestAnimationFrame(() => formRef.current?.requestSubmit())}
        className="w-28"
        size="sm"
        align="end"
        aria-label="Role"
        options={ORG_ROLE_NAMES.map((r) => ({ value: r, label: r }))}
      />
    </form>
  );
}

export function DeleteOrganization({ organizationId, slug }: { organizationId: string; slug: string }) {
  const [confirm, setConfirm] = useState("");
  return (
    <CardBody>
      <form action={adminDeleteOrganization} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="min-w-64">
          <Field label={`Type "${slug}" to confirm`} htmlFor="confirmSlug">
            <Input
              id="confirmSlug"
              name="confirmSlug"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
        <Button type="submit" variant="danger" disabled={confirm !== slug}>
          Delete organization permanently
        </Button>
      </form>
    </CardBody>
  );
}
