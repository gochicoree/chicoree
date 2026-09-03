import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { SmtpForm } from "./forms";

export const metadata: Metadata = { title: "Email settings" };

export default async function AdminEmailSettings() {
  const s = await getInstanceSettings();
  return <SmtpForm smtp={{ ...s.smtp, pass: "" }} hasPassword={!!s.smtp.pass} source={s.sources.smtp} />;
}
