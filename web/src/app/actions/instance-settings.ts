"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import {
  getInstanceSettings,
  resetSettingsSection,
  saveSettingsSection,
  type LdapSettings,
  type SettingsSection,
  type SmtpSettings,
} from "@/lib/instance-settings";
import { sendTestMail } from "@/lib/email";
import { parseGroupBindings } from "@/lib/group-bindings";
import { testLdapConnection } from "@/lib/ldap";

export interface SettingsResult {
  error?: string;
  saved?: boolean;
  message?: string;
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const bool = (fd: FormData, key: string) => fd.get(key) === "on";

function done(section: SettingsSection): SettingsResult {
  revalidatePath("/admin/settings", "layout");
  revalidatePath("/sign-in");
  return { saved: true, message: `${section} settings saved` };
}

function smtpFromForm(fd: FormData): SmtpSettings {
  return {
    host: str(fd, "host"),
    port: Number(str(fd, "port") || 587),
    secure: bool(fd, "secure"),
    user: str(fd, "user"),
    pass: String(fd.get("pass") ?? ""),
    from: str(fd, "from"),
  };
}

export async function saveSmtpSettings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const smtp = smtpFromForm(fd);
  if (!Number.isInteger(smtp.port) || smtp.port <= 0) return { error: "Port must be a positive number." };
  await saveSettingsSection("smtp", { ...smtp });
  return done("smtp");
}

export async function sendTestEmail(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  const session = await requireAdmin();
  const form = smtpFromForm(fd);
  // A blank password means "the stored one"; fall back to the effective settings for it.
  const current = (await getInstanceSettings()).smtp;
  const smtp: SmtpSettings = { ...form, pass: form.pass && form.pass !== "-" ? form.pass : form.pass === "-" ? "" : current.pass };
  const to = str(fd, "testTo") || session.user.email;
  try {
    await sendTestMail(smtp, to);
    return { message: `Test email sent to ${to}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Sending failed." };
  }
}

export async function saveOAuthProvider(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const provider = str(fd, "provider");
  if (provider !== "github" && provider !== "google" && provider !== "oidc") return { error: "Unknown provider." };
  const base = { enabled: bool(fd, "enabled"), clientId: str(fd, "clientId"), clientSecret: String(fd.get("clientSecret") ?? "") };
  if (provider === "oidc") {
    const issuer = str(fd, "issuer").replace(/\/$/, "");
    if (base.enabled && !/^https?:\/\//.test(issuer)) return { error: "The issuer must be an https:// URL." };
    await saveSettingsSection("oidc", {
      ...base,
      issuer,
      name: str(fd, "name") || "SSO",
      scopes: str(fd, "scopes") || "openid profile email",
      groupsClaim: str(fd, "groupsClaim") || "groups",
    });
  } else {
    await saveSettingsSection(provider, base);
  }
  return done(provider);
}

function ldapFromForm(fd: FormData): LdapSettings {
  return {
    enabled: bool(fd, "enabled"),
    url: str(fd, "url"),
    name: str(fd, "name") || "LDAP",
    bindDn: str(fd, "bindDn"),
    bindPassword: String(fd.get("bindPassword") ?? ""),
    userBase: str(fd, "userBase"),
    userFilter: str(fd, "userFilter") || "(&(objectClass=person)(uid={{username}}))",
    attrEmail: str(fd, "attrEmail") || "mail",
    attrName: str(fd, "attrName") || "cn",
    attrGroups: str(fd, "attrGroups") || "memberOf",
    groupBase: str(fd, "groupBase"),
    groupFilter: str(fd, "groupFilter") || "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))",
    emailDomain: str(fd, "emailDomain"),
    startTls: bool(fd, "startTls"),
    tlsInsecure: bool(fd, "tlsInsecure"),
    tlsCaFile: str(fd, "tlsCaFile"),
    timeoutMs: Number(str(fd, "timeoutMs") || 10000),
  };
}

export async function saveLdapSettings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const ldap = ldapFromForm(fd);
  if (ldap.enabled && !/^ldaps?:\/\//.test(ldap.url)) return { error: "The URL must start with ldap:// or ldaps://." };
  if (ldap.enabled && !ldap.userBase) return { error: "The user search base is required." };
  await saveSettingsSection("ldap", { ...ldap });
  return done("ldap");
}

export async function testLdapSettings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const form = ldapFromForm(fd);
  const current = (await getInstanceSettings()).ldap;
  const cfg: LdapSettings = {
    ...form,
    bindPassword: form.bindPassword && form.bindPassword !== "-" ? form.bindPassword : form.bindPassword === "-" ? "" : current.bindPassword,
  };
  const sample = str(fd, "testUsername") || "someone";
  try {
    const { entries, dn } = await testLdapConnection(cfg, sample);
    return {
      message:
        entries === 0
          ? `Connected and bound; the user filter matched nothing for "${sample}".`
          : `Connected; "${sample}" resolves to ${dn}${entries > 1 ? ` (+${entries - 1} more)` : ""}.`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Connection failed." };
  }
}

export async function saveGroupBindings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const text = String(fd.get("text") ?? "").trim();
  try {
    parseGroupBindings(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid bindings." };
  }
  await saveSettingsSection("bindings", { text });
  return done("bindings");
}

/** Drop the stored section so the environment defaults apply again. */
export async function resetSection(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const section = str(fd, "section") as SettingsSection;
  if (!["smtp", "github", "google", "oidc", "ldap", "bindings"].includes(section)) return { error: "Unknown section." };
  await resetSettingsSection(section);
  revalidatePath("/admin/settings", "layout");
  revalidatePath("/sign-in");
  return { saved: true, message: "Reverted to the environment configuration" };
}
