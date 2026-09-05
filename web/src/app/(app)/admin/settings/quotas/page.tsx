import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../../admin-nav";
import { PortalForm, QuotaDefaultsForm } from "./quotas-form";

export const metadata: Metadata = { title: "Limits" };

export default async function AdminQuotaSettings() {
  await requireAdmin();
  const s = await getInstanceSettings();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="What new accounts and organizations may use, and where people manage their account. Limits of existing accounts are set under Users and Organizations."
      />
      <AdminNav />
      <div className="space-y-6">
        <QuotaDefaultsForm values={s.quotas} source={s.sources.quotas} />
        <PortalForm values={s.portal} source={s.sources.portal} />
      </div>
    </>
  );
}
