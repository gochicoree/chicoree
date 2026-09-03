import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { canCreateOrganization, ORG_CREATION_DENIED } from "@/lib/signup-policy";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { NewOrganizationForm } from "./new-org-form";

export const metadata: Metadata = { title: "Create an organization" };

export default async function NewOrganizationPage() {
  const session = await requireSession();
  const settings = await getInstanceSettings();
  const allowed = canCreateOrganization(settings.access, session.user.role);

  return (
    <div>
      <PageHeader
        eyebrow="Organizations"
        title="Create an organization"
        description="An organization is a namespace for images: registry/<slug>/<repository>."
      />
      {allowed ? (
        <NewOrganizationForm />
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-2">{ORG_CREATION_DENIED} Ask an administrator to create one and add you as a member.</p>
            <Link href="/dashboard" className={buttonClasses("secondary", "sm")}>
              Back to dashboard
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
