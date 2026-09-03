// Server-side access to the branding section, safe to call from the root
// layout: request headers are read first so a production build never reaches
// the database while prerendering, and any failure falls back to defaults.
import { cache } from "react";
import { headers } from "next/headers";
import { DEFAULT_BRANDING, type BrandingSettings } from "./branding-shared";
import { getInstanceSettings } from "./instance-settings";

export const getBranding = cache(async (): Promise<BrandingSettings> => {
  try {
    await headers();
    const s = await getInstanceSettings();
    return { ...DEFAULT_BRANDING, ...s.branding, announcement: { ...DEFAULT_BRANDING.announcement, ...s.branding.announcement } };
  } catch {
    return DEFAULT_BRANDING;
  }
});

/** Branding without a request scope (emails, background work). */
export async function getBrandingPlain(): Promise<BrandingSettings> {
  try {
    const s = await getInstanceSettings();
    return { ...DEFAULT_BRANDING, ...s.branding };
  } catch {
    return DEFAULT_BRANDING;
  }
}
