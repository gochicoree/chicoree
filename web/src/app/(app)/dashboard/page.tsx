import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpFromLine, Container, KeyRound, MailOpen, Plus } from "lucide-react";
import { requireSession } from "@/lib/session";
import { recentActivity } from "@/lib/data";
import { listOrgOverview, listPendingInvitations, listUserPushes, userTokenSummary } from "@/lib/dashboard";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PaginationFooter } from "@/components/ui/pagination";
import { pageParam } from "@/lib/paginate-shared";
import { CommandLine } from "@/components/ui/copy";
import { ActivityFeed } from "@/components/activity-feed";
import { buttonClasses } from "@/components/ui/button";
import { imageReference } from "@/lib/library";
import { getInstanceSettings } from "@/lib/instance-settings";
import { canCreateOrganization } from "@/lib/signup-policy";
import { userOnboarding } from "@/lib/onboarding";
import { listRecentlyViewed, listStarredRepos } from "@/lib/stars";
import { logoRef } from "@/lib/logo-shared";
import { viewerFromSession } from "@/lib/viewer";
import { relativeTime, shortDigest } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { RepoShortlist } from "@/components/repo-shortlist";
import { OrgOverviewGrid } from "@/components/org-overview";
import { EntityLogo } from "@/components/entity-logo";
import { VisibilityBadge } from "@/components/ui/badge";

import { imagePath } from "@/lib/library-shared";
export const metadata: Metadata = { title: "Dashboard" };

/** "expires today" / "expires in 3 days" for an invitation that is still open. */
function expiresIn(date: Date): string {
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "expires today";
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}

/**
 * The signed-in user's home: their organizations, what happened in them,
 * what they pushed themselves, and the repositories they keep coming back
 * to. Instance-wide numbers live under /admin, not here.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const viewer = viewerFromSession(session);
  const [overview, activity, pushes, tokens, invitations, settings, onboarding, starred, recent] = await Promise.all([
    listOrgOverview(session.user.id, 6),
    recentActivity({ userId: session.user.id, page: pageParam(params, "activity") }),
    listUserPushes(session.user.id, 8),
    userTokenSummary(session.user.id),
    listPendingInvitations(session.user.email),
    getInstanceSettings(),
    userOnboarding(session.user.id),
    listStarredRepos(viewer, session.user.id, 50),
    listRecentlyViewed(viewer, session.user.id, 50),
  ]);
  const showOnboarding = !onboarding.dismissed && !onboarding.complete;
  // The checklist carries the same commands while it is up; afterwards the
  // quick start stays until the user has pushed something.
  const showQuickStart = !showOnboarding && !onboarding.hasPush;
  const canCreateOrgs = canCreateOrganization(settings.access, session.user.role);
  const sampleOrg = onboarding.orgSlug ?? "<org>";

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`Welcome back, ${session.user.name.split(" ")[0]}`}
        description="Your organizations and what's new in them."
        action={
          canCreateOrgs ? (
            <Link href="/orgs/new" className={buttonClasses("secondary")}>
              <Plus className="size-4" /> New organization
            </Link>
          ) : undefined
        }
      />

      {invitations.length > 0 && (
        <Card className="mb-6 border-accent/30" data-invitations={invitations.length}>
          <CardHeader
            eyebrow="Invitations"
            title={invitations.length === 1 ? "You have been invited to an organization" : `You have ${invitations.length} organization invitations`}
          />
          <CardBody>
            <ul className="space-y-2">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <MailOpen className="size-4 shrink-0 text-accent" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {inv.inviterName ?? "Someone"} invited you to <span className="font-medium text-ink">{inv.organizationName}</span>
                      {inv.role ? <span className="text-ink-2"> as {inv.role}</span> : null}
                      <span className="text-ink-3"> · {expiresIn(inv.expiresAt)}</span>
                    </span>
                  </span>
                  <Link href={`/accept-invitation/${encodeURIComponent(inv.id)}`} className={buttonClasses("primary", "sm")}>
                    View invitation
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {showOnboarding && (
        <div className="mb-6">
          <OnboardingChecklist state={onboarding} registryHost={env.registryHost} />
        </div>
      )}

      <OrgOverviewGrid orgs={overview.orgs} total={overview.total} canCreate={canCreateOrgs} />

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader
            eyebrow="Log"
            title="Recent activity"
            description="Pushes and deletions in the organizations you belong to."
          />
          <CardBody className="max-h-[32rem] overflow-y-auto">
            <ActivityFeed items={activity.rows} />
          </CardBody>
          <PaginationFooter
            state={activity.state}
            noun="events"
            basePath="/dashboard"
            params={params}
            paramKey="activity"
            label="Activity pages"
          />
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader eyebrow="You" title="Your recent pushes" description="Pushed with your account or one of your access tokens." />
            <CardBody>
              {pushes.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
                  Nothing pushed from your account in the last 90 days.
                </p>
              ) : (
                <ul className="space-y-0.5" data-user-pushes={pushes.length}>
                  {pushes.map((p) => {
                    const base = repoHref(p.orgSlug, p.repoName);
                    const ref = p.tag ?? p.digest;
                    const href = ref ? `${base}/tags/${encodeURIComponent(ref)}` : base;
                    return (
                      <li key={`${p.repoId}:${ref ?? ""}`}>
                        <Link href={href} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-card-2">
                          <EntityLogo
                            kind="repository"
                            name={imagePath(p.orgSlug, p.repoName)}
                            logo={logoRef("repository", p.repoId, p.logoVersion)}
                            size={18}
                            fallback={<Container className="size-3.5 text-ink-3" />}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium text-ink">
                              {imagePath(p.orgSlug, p.repoName)}
                            </span>
                            {p.tag ? (
                              <span className="font-mono text-ink-2">:{p.tag}</span>
                            ) : p.digest ? (
                              <span className="font-mono text-ink-3"> @{shortDigest(p.digest, 8)}</span>
                            ) : null}
                          </span>
                          <VisibilityBadge visibility={p.visibility} />
                          <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{relativeTime(p.pushedAt)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card data-token-summary>
            <CardHeader
              eyebrow="Account"
              title="Access tokens"
              description="For docker login and the API."
              action={
                <Link href="/settings/tokens" className={buttonClasses("secondary", "sm")}>
                  <KeyRound className="size-3.5" /> Manage
                </Link>
              }
            />
            <CardBody>
              {tokens.total === 0 ? (
                <p className="text-sm text-ink-2">
                  You have no access tokens yet. Create one to push and pull with docker, or to use the API.
                </p>
              ) : (
                <dl className="grid grid-cols-3 gap-2">
                  <div>
                    <dt className="text-xs text-ink-3">Tokens</dt>
                    <dd className="font-mono text-base font-semibold tabular-nums">{tokens.total}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Expiring in 7 days</dt>
                    <dd className={`font-mono text-base font-semibold tabular-nums ${tokens.expiringSoon > 0 ? "text-danger" : ""}`}>
                      {tokens.expiringSoon}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Last used</dt>
                    <dd className="font-mono text-base font-semibold tabular-nums">{tokens.lastUsedAt ? relativeTime(tokens.lastUsedAt) : "—"}</dd>
                  </div>
                </dl>
              )}
              {tokens.expired > 0 && (
                <p className="mt-3 text-xs text-ink-3">
                  {tokens.expired} expired token{tokens.expired === 1 ? "" : "s"} can be deleted from the tokens page.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Yours" title="Starred" description="Repositories you starred, newest first." />
          <CardBody>
            <RepoShortlist
              name="starred"
              emptyText="Star a repository from its page and it shows up here."
              items={starred.map((r) => ({
                id: r.id,
                path: imagePath(r.orgSlug, r.name),
                href: repoHref(r.orgSlug ?? "", r.name),
                visibility: r.visibility,
                proxy: r.proxy,
                meta: `starred ${relativeTime(r.starredAt)}`,
                logo: logoRef("repository", r.id, r.logoVersion),
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader eyebrow="History" title="Recently viewed" description="Repository pages you opened." />
          <CardBody>
            <RepoShortlist
              name="recent"
              emptyText="Open a repository and it will be listed here."
              items={recent.map((r) => ({
                id: r.id,
                path: imagePath(r.orgSlug, r.name),
                href: repoHref(r.orgSlug ?? "", r.name),
                visibility: r.visibility,
                proxy: r.proxy,
                meta: `viewed ${relativeTime(r.lastVisitedAt)}`,
                logo: logoRef("repository", r.id, r.logoVersion),
              }))}
            />
          </CardBody>
        </Card>
      </div>

      {showQuickStart && (
        <Card className="mt-6" data-quick-start>
          <CardHeader
            eyebrow="Quick start"
            title="Push your first image"
            description="Log in with an access token, then tag and push."
            icon={<ArrowUpFromLine className="mt-0.5 size-4 text-accent" />}
          />
          <CardBody className="space-y-2">
            <CommandLine command={`docker login ${env.registryHost}`} />
            <CommandLine command={`docker tag alpine ${imageReference(env.registryHost, sampleOrg, "alpine", "latest")}`} />
            <CommandLine command={`docker push ${imageReference(env.registryHost, sampleOrg, "alpine", "latest")}`} />
            <p className="pt-1 text-xs text-ink-2">
              Use your email as the username and an{" "}
              <Link href="/settings/tokens" className="font-medium text-ink underline-offset-2 hover:underline">
                access token
              </Link>{" "}
              as the password.
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}
