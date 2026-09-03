"use server";

// Admin platform actions: sign-up controls and branding. Both sections live
// in instance_settings next to SMTP / providers and follow the same
// "environment as default, database overrides" rule.
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { saveSettingsSection, type AccessSettings, type BrandingSettings } from "@/lib/instance-settings";
import { parseDomainList, type OrgCreationPolicy, type SignUpMode } from "@/lib/access-shared";
import {
  ANNOUNCEMENT_MAX_CHARS,
  DEFAULT_BRANDING,
  INSTANCE_NAME_MAX,
  isHexColor,
  sanitizeFooterLinks,
  TAGLINE_MAX,
  validateLogoDataUrl,
  type AnnouncementLevel,
} from "@/lib/branding-shared";
import { recordAudit } from "@/lib/audit";
import type { SettingsResult } from "./instance-settings";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const bool = (fd: FormData, key: string) => fd.get(key) === "on";

export async function saveAccessSettings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const mode = str(fd, "signUpMode");
  const orgs = str(fd, "allowOrganizationCreation");
  if (!["open", "invite", "closed"].includes(mode)) return { error: "Unknown sign-up mode." };
  if (!["everyone", "admins"].includes(orgs)) return { error: "Unknown organization policy." };
  const access: AccessSettings = {
    signUpMode: mode as SignUpMode,
    allowedEmailDomains: parseDomainList(String(fd.get("domains") ?? "")),
    allowOrganizationCreation: orgs as OrgCreationPolicy,
  };
  await saveSettingsSection("access", { ...access });
  await recordAudit({ action: "settings.update", targetType: "settings", targetId: "access", targetLabel: "access", details: { ...access } });
  revalidatePath("/admin/auth", "layout");
  revalidatePath("/sign-in");
  revalidatePath("/sign-up");
  revalidatePath("/", "layout");
  return { saved: true, message: "Access settings saved" };
}

export async function saveBrandingSettings(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  await requireAdmin();
  const instanceName = str(fd, "instanceName").slice(0, INSTANCE_NAME_MAX) || DEFAULT_BRANDING.instanceName;
  const tagline = str(fd, "tagline").slice(0, TAGLINE_MAX);
  const accentColor = str(fd, "accentColor");
  if (accentColor && !isHexColor(accentColor)) return { error: "The accent colour must be a hex value like #3d68c7." };
  const logoDataUrl = String(fd.get("logoDataUrl") ?? "").trim();
  if (logoDataUrl) {
    const check = validateLogoDataUrl(logoDataUrl);
    if (!check.ok) return { error: check.error };
  }
  const labels = fd.getAll("footerLabel").map(String);
  const urls = fd.getAll("footerUrl").map(String);
  const footerLinks = sanitizeFooterLinks(labels.map((label, i) => ({ label, url: urls[i] ?? "" })));
  const level = str(fd, "announcementLevel");
  if (!["info", "warning", "danger"].includes(level)) return { error: "Unknown announcement level." };
  const text = str(fd, "announcementText").replace(/\s+/g, " ");
  if (text.length > ANNOUNCEMENT_MAX_CHARS) return { error: `Announcements are limited to ${ANNOUNCEMENT_MAX_CHARS} characters.` };
  const enabled = bool(fd, "announcementEnabled") && text.length > 0;
  const branding: BrandingSettings = {
    instanceName,
    tagline,
    logoDataUrl,
    accentColor: accentColor.toLowerCase(),
    footerLinks,
    announcement: { enabled, level: level as AnnouncementLevel, text, dismissible: bool(fd, "announcementDismissible") },
  };
  await saveSettingsSection("branding", { ...branding });
  await recordAudit({
    action: "settings.update",
    targetType: "settings",
    targetId: "branding",
    targetLabel: "branding",
    details: { instanceName, tagline, accentColor: branding.accentColor, logoBytes: logoDataUrl ? Math.round((logoDataUrl.length - logoDataUrl.indexOf(",") - 1) * 0.75) : 0, footerLinks: footerLinks.length, announcement: enabled ? level : "off" },
  });
  revalidatePath("/", "layout");
  return { saved: true, message: "Branding saved" };
}
