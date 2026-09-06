import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import type { OrgOverview } from "@/lib/dashboard";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { EntityLogo } from "@/components/entity-logo";
import { buttonClasses } from "@/components/ui/button";
import { logoRef } from "@/lib/logo-shared";
import { MANAGER_ROLES, WRITER_ROLES, type OrgRole } from "@/lib/org-roles";
import { isLibrary } from "@/lib/library-shared";

/**
 * The dashboard's organization cards: one per organization the user belongs
 * to, with their role, the size of the place and how alive it is. The whole
 * card opens the organization; the small links at the bottom are shortcuts
 * for what the user's role lets them do there.
 */
export function OrgOverviewGrid({
  orgs,
  total,
  canCreate,
}: {
  orgs: OrgOverview[];
  /** Every membership, including the ones not shown. */
  total: number;
  canCreate: boolean;
}) {
  return (
    <section data-org-overview data-count={orgs.length}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold">Your organizations</h2>
        {total > orgs.length && (
          <Link href="/orgs" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
            All {total} organizations <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
      {orgs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
          <p className="text-sm text-ink-2">
            {canCreate
              ? "You are not a member of any organization yet. Create one to get a namespace for your images."
              : "You are not a member of any organization yet. Ask an administrator to add you to one."}
          </p>
          {canCreate && (
            <Link href="/orgs/new" className={buttonClasses("primary", "sm", "mt-4")}>
              <Plus className="size-3.5" /> New organization
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {orgs.map((org) => (
            <OrgCard key={org.id} org={org} />
          ))}
        </div>
      )}
    </section>
  );
}

function OrgCard({ org }: { org: OrgOverview }) {
  const role = org.role as OrgRole;
  const manages = MANAGER_ROLES.includes(role);
  const writes = WRITER_ROLES.includes(role) && !org.proxy;
  const shortcuts = [
    { href: `/${org.slug}/members`, label: "Members", show: true },
    { href: `/${org.slug}/new-repository`, label: "New repository", show: writes },
    { href: `/${org.slug}/settings`, label: "Settings", show: manages },
  ].filter((s) => s.show);

  return (
    <div
      className="relative rounded-xl border border-line bg-card p-4 shadow-card transition-colors hover:border-ink-3"
      data-org-card={org.slug}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <EntityLogo kind="organization" name={org.name} logo={logoRef("organization", org.id, org.logoVersion)} size={22} />
          {/* Stretched over the card, so a click anywhere opens the organization. */}
          <Link href={`/${org.slug}`} className="truncate font-medium text-ink after:absolute after:inset-0 after:rounded-xl">
            {org.name}
          </Link>
        </div>
        <Badge tone={manages ? "accent" : "neutral"}>{org.role}</Badge>
      </div>
      <div className="mt-1 truncate font-mono text-xs text-ink-3">{isLibrary(org.slug) ? "top-level images, no prefix" : `${org.slug}/`}</div>

      <dl className="mt-4 grid grid-cols-3 gap-2">
        <div>
          <dt className="text-xs text-ink-3">{org.proxy ? "Cached images" : "Repositories"}</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">{org.repoCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Pulls, 30 days</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">{formatCount(org.pulls30d)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">{org.proxy ? "Last cached" : "Last push"}</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">{org.lastPushAt ? relativeTime(org.lastPushAt) : "—"}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-3 text-xs text-ink-2">
        <span>
          {org.memberCount} member{org.memberCount === 1 ? "" : "s"}
          <span className="text-ink-3"> · </span>
          {formatBytes(org.storageBytes)}
        </span>
        {/* Positioned after the stretched link in the DOM, so these stay clickable on top of it. */}
        <span className="relative flex items-center gap-2.5">
          {shortcuts.map((s) => (
            <Link key={s.href} href={s.href} className="font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              {s.label}
            </Link>
          ))}
        </span>
      </div>
    </div>
  );
}
