import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { LdapForm } from "../forms";

export const metadata: Metadata = { title: "LDAP settings" };

export default async function AdminLdapSettings() {
  const s = await getInstanceSettings();
  return <LdapForm ldap={{ ...s.ldap, bindPassword: "" }} hasBindPassword={!!s.ldap.bindPassword} source={s.sources.ldap} />;
}
