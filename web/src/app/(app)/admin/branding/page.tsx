import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../admin-nav";
import { BrandingForm } from "./branding-form";

export const metadata: Metadata = { title: "Branding" };

export default async function AdminBrandingPage() {
  await requireAdmin();
  const s = await getInstanceSettings();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Name, logo, colour and footer of this registry, plus an announcement shown to everyone."
      />
      <AdminNav />
      <BrandingForm branding={s.branding} source={s.sources.branding} />
    </>
  );
}
