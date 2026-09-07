"use client";

import { useRef } from "react";
import { adminDeleteOrganization, adminSetMemberRole } from "@/app/actions/admin-orgs";
import { ORG_ROLE_NAMES } from "@/lib/org-roles";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CardBody } from "@/components/ui/card";
import { ConfirmForm } from "@/components/ui/confirm";

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

/** Delete behind a dialog that asks for the organization's slug. */
export function DeleteOrganization({ organizationId, slug }: { organizationId: string; slug: string }) {
  return (
    <CardBody>
      <ConfirmForm
        action={adminDeleteOrganization}
        title={`Delete ${slug}?`}
        description="Every repository, image, member, invitation and service account of this organization is deleted. Pulls of its images stop working. This cannot be undone."
        confirmLabel="Delete organization"
        tone="danger"
        confirmText={slug}
        confirmInputName="confirmSlug"
      >
        <input type="hidden" name="organizationId" value={organizationId} />
        <Button type="submit" variant="danger">
          Delete organization…
        </Button>
      </ConfirmForm>
    </CardBody>
  );
}
