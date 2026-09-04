import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireSession } from "@/lib/session";
import { listUserOrgs, pullSeries, recentActivity } from "@/lib/data";
import { env } from "@/lib/env";
import { formatBytes } from "@/lib/format";
import { PageHeader, StatTile } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CommandLine } from "@/components/ui/copy";
import { PullsChart } from "@/components/pulls-chart";
import { ActivityFeed } from "@/components/activity-feed";
import { buttonClasses } from "@/components/ui/button";
import { imageReference } from "@/lib/library";
import { getInstanceSettings } from "@/lib/instance-settings";
import { canCreateOrganization } from "@/lib/signup-policy";
import { userOnboarding } from "@/lib/onboarding";
import { listRecentlyViewed, listStarredRepos } from "@/lib/stars";
import { viewerFromSession } from "@/lib/viewer";
import { relativeTime } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { RepoShortlist } from "@/components/repo-shortlist";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireSession();
  const viewer = viewerFromSession(session);
  const [orgs, series, activity, settings, onboarding, starred, recent] = await Promise.all([
    listUserOrgs(session.user.id),
    pullSeries({ userId: session.user.id, days: 30 }),
    recentActivity({ userId: session.user.id, limit: 12 }),
    getInstanceSettings(),
    userOnboarding(session.user.id),
    listStarredRepos(viewer, session.user.id, 50),
    listRecentlyViewed(viewer, session.user.id, 50),
  ]);
  const showOnboarding = !onboarding.dismissed && !onboarding.complete;
  const canCreateOrgs = canCreateOrganization(settings.access, session.user.role);
  const totalRepos = orgs.reduce((sum, o) => sum + o.repoCount, 0);
  const totalStorage = orgs.reduce((sum, o) => sum + o.storageBytes, 0);
  const pulls30d = series.reduce((sum, d) => sum + d.count, 0);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`Welcome back, ${session.user.name.split(" ")[0]}`}
        description="What's moving through your registry."
        action={
          canCreateOrgs ? (
            <Link href="/orgs/new" className={buttonClasses("secondary")}>
              <Plus className="size-4" /> New organization
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Organizations" value={orgs.length} />
        <StatTile label="Repositories" value={totalRepos} />
        <StatTile label="Storage used" value={formatBytes(totalStorage)} detail="deduplicated" />
        <StatTile label="Pulls, 30 days" value={pulls30d} />
      </div>

      {showOnboarding && (
        <div className="mt-6">
          <OnboardingChecklist state={onboarding} registryHost={env.registryHost} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader eyebrow="Activity" title="Pulls per day" description="Last 30 days, all your organizations" />
          <CardBody>
            <PullsChart data={series} />
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader eyebrow="Log" title="Recent activity" />
          <CardBody className="max-h-80 overflow-y-auto">
            <ActivityFeed items={activity} />
          </CardBody>
        </Card>
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
                path: `${r.orgSlug}/${r.name}`,
                href: repoHref(r.orgSlug ?? "", r.name),
                visibility: r.visibility,
                proxy: r.proxy,
                meta: `starred ${relativeTime(r.starredAt)}`,
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
                path: `${r.orgSlug}/${r.name}`,
                href: repoHref(r.orgSlug ?? "", r.name),
                visibility: r.visibility,
                proxy: r.proxy,
                meta: `viewed ${relativeTime(r.lastVisitedAt)}`,
              }))}
            />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          eyebrow="Quick start"
          title="Push your first image"
          description="Sign in with a personal access token, then tag and push."
        />
        <CardBody className="space-y-2">
          <CommandLine command={`docker login ${env.registryHost}`} />
          <CommandLine command={`docker tag alpine ${imageReference(env.registryHost, orgs[0]?.slug ?? "<org>", "alpine", "latest")}`} />
          <CommandLine command={`docker push ${imageReference(env.registryHost, orgs[0]?.slug ?? "<org>", "alpine", "latest")}`} />
          <p className="pt-1 text-xs text-ink-2">
            Use your email as the username and an{" "}
            <Link href="/settings/tokens" className="font-medium text-ink underline-offset-2 hover:underline">
              access token
            </Link>{" "}
            as the password.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
