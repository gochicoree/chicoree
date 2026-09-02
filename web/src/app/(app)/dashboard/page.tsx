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

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireSession();
  const [orgs, series, activity] = await Promise.all([
    listUserOrgs(session.user.id),
    pullSeries({ userId: session.user.id, days: 30 }),
    recentActivity({ userId: session.user.id, limit: 12 }),
  ]);
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
          <Link href="/orgs/new" className={buttonClasses("secondary")}>
            <Plus className="size-4" /> New organization
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Organizations" value={orgs.length} />
        <StatTile label="Repositories" value={totalRepos} />
        <StatTile label="Storage used" value={formatBytes(totalStorage)} detail="deduplicated" />
        <StatTile label="Pulls, 30 days" value={pulls30d} />
      </div>

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
