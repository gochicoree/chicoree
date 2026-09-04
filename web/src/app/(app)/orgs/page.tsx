import type { Metadata } from "next";
import Link from "next/link";
import { Container, Plus } from "lucide-react";
import { requireSession } from "@/lib/session";
import { listUserOrgs } from "@/lib/data";
import { getInstanceSettings } from "@/lib/instance-settings";
import { canCreateOrganization } from "@/lib/signup-policy";
import { formatBytes } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { OrgFilter } from "./org-filter";

export const metadata: Metadata = { title: "Organizations" };

/**
 * Every organization the signed-in user belongs to. The sidebar only lists
 * the handful they opened last, so this is where the rest live.
 */
export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().toLowerCase();
  const [all, settings] = await Promise.all([listUserOrgs(session.user.id), getInstanceSettings()]);
  const orgs = q ? all.filter((o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q)) : all;
  const mayCreate = canCreateOrganization(settings.access, session.user.role);

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Organizations"
        description={`You are a member of ${all.length} organization${all.length === 1 ? "" : "s"}.`}
        action={
          mayCreate ? (
            <Link href="/orgs/new" className={buttonClasses("primary", "sm")}>
              <Plus className="size-4" /> New organization
            </Link>
          ) : undefined
        }
      />

      {all.length > 8 && <OrgFilter initial={q} />}

      {orgs.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-ink-2">
            {all.length === 0
              ? mayCreate
                ? "You are not a member of any organization yet."
                : "You are not a member of any organization yet; ask an administrator to add you."
              : `No organization matches “${q}”.`}
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {orgs.map((org) => (
            <Link
              key={org.id}
              href={`/${org.slug}`}
              className="rounded-xl border border-line bg-card p-4 transition-colors hover:border-ink-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Container className="size-4 shrink-0 text-ink-3" />
                  <span className="truncate font-medium text-ink">{org.name}</span>
                </div>
                <Badge tone={org.role === "owner" || org.role === "admin" ? "accent" : "neutral"}>{org.role}</Badge>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-ink-3">{org.slug}/</div>
              <div className="mt-3 flex items-center gap-3 text-xs text-ink-2">
                <span>
                  {org.repoCount} repositor{org.repoCount === 1 ? "y" : "ies"}
                </span>
                <span className="text-ink-3">·</span>
                <span>{formatBytes(org.storageBytes)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
