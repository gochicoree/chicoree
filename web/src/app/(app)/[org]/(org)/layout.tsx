import { headers } from "next/headers";
import { Container, Globe } from "lucide-react";
import { redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath } from "@/lib/data";
import { LIBRARY_SLUG } from "@/lib/library-shared";
import { Badge } from "@/components/ui/badge";
import { OrgTabs } from "./org-tabs";
import { isLibrary } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { displayHost } from "@/lib/proxy-shared";
import { redirectMovedOrganization } from "@/lib/redirects";
import { EntityLogo } from "@/components/entity-logo";
import { logoVersionOf } from "@/lib/logo";
import { logoRef } from "@/lib/logo-shared";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) {
    // A renamed organization: 308 to the same page under the new slug. The
    // request path comes from proxy.ts (layouts cannot see the URL).
    const pathname = (await headers()).get("x-pathname") ?? "";
    const suffix = pathname.startsWith(`/${slug}/`) ? pathname.slice(slug.length + 1) : "";
    // `/nginx` is how a top-level image is pulled; open the repository behind it.
    if (!suffix && (await getRepoByPath(LIBRARY_SLUG, slug))) redirect(`/${LIBRARY_SLUG}/${slug}`);
    return redirectMovedOrganization(slug, suffix);
  }
  const { org, role } = ctx;
  const proxy = await getOrgProxy(org.id);
  const upstream = proxy ? displayHost(proxy.upstreamUrl) : null;

  return (
    <>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <EntityLogo
            kind="organization"
            name={org.name}
            logo={logoRef("organization", org.id, logoVersionOf(org.logo))}
            size={40}
            fallback={
              <span className="flex size-full items-center justify-center rounded-xl bg-action text-action-ink">
                <Container className="size-5" />
              </span>
            }
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words font-display text-xl font-bold tracking-tight">{org.name}</h1>
              {role && <Badge tone="info">{role}</Badge>}
              {isLibrary(org.slug) && <Badge tone="accent">top-level images</Badge>}
              {upstream && (
                <Badge tone="accent" title={proxy?.upstreamUrl}>
                  <Globe className="size-3" /> proxy cache of {upstream}
                </Badge>
              )}
              {proxy && !proxy.enabled && <Badge tone="neutral">paused</Badge>}
            </div>
            <div className="font-mono text-[13px] text-ink-2">
              {isLibrary(org.slug) ? "registry/<image> (no prefix)" : upstream ? `${org.slug}/<${upstream} image>` : `${org.slug}/`}
            </div>
          </div>
        </div>
        <OrgTabs slug={org.slug} canManage={role === "owner" || role === "admin"} isMember={!!role} />
      </div>
      {children}
    </>
  );
}
