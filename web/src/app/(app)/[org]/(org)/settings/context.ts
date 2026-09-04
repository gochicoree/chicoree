import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { isLibrary } from "@/lib/library";
import { redirectMovedOrganization } from "@/lib/redirects";

/** Organization + access check shared by every settings tab (owners and admins). */
export async function orgSettingsContext(params: Promise<{ org: string }>) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) {
    const pathname = (await headers()).get("x-pathname") ?? "";
    const marker = pathname.indexOf("/settings");
    return redirectMovedOrganization(slug, marker >= 0 ? pathname.slice(marker) : "/settings");
  }
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect(`/${slug}`);
  const library = isLibrary(ctx.org.slug);
  return { org: ctx.org, role: ctx.role, library, canDelete: ctx.role === "owner" && !library, base: `/${slug}/settings` };
}
