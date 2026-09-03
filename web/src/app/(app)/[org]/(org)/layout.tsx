import { notFound } from "next/navigation";
import { Container, Globe } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { OrgTabs } from "./org-tabs";
import { isLibrary } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { displayHost } from "@/lib/proxy-shared";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  const { org, role } = ctx;
  const proxy = await getOrgProxy(org.id);
  const upstream = proxy ? displayHost(proxy.upstreamUrl) : null;

  return (
    <>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-action text-action-ink">
            <Container className="size-5" />
          </div>
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
