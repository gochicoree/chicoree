import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { SmtpForm } from "../auth/forms";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../admin-nav";

export const metadata: Metadata = { title: "Email settings" };

export default async function AdminEmailSettings() {
  const s = await getInstanceSettings();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Outgoing mail for verification, password resets, magic links, one-time codes and invitations."
      />
      <AdminNav />
      <SmtpForm smtp={{ ...s.smtp, pass: "" }} hasPassword={!!s.smtp.pass} source={s.sources.smtp} />
    </>
  );
}
