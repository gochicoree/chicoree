import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { listOrgRepos } from "@/lib/data";
import { formatBytes, relativeTime } from "@/lib/format";
import { adminDeleteRepository } from "@/app/actions/admin-orgs";
import { Card, CardHeader } from "@/components/ui/card";
import { VisibilityBadge } from "@/components/ui/badge";
import { repoHref } from "@/lib/proxy-shared";
import { EntityLogo } from "@/components/entity-logo";
import { logoRef } from "@/lib/logo-shared";

export default async function AdminOrganizationRepositories({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, id) });
  if (!org) notFound();
  const repos = await listOrgRepos(org.id, true);

  return (
    <Card>
      <CardHeader eyebrow="Content" title={`Repositories (${repos.length})`} />
      {repos.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-3">No repositories.</p>
      ) : (
        <div>
          {repos.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5">
              <EntityLogo kind="repository" name={r.name} logo={logoRef("repository", r.id, r.logoVersion)} size={20} />
              <Link href={repoHref(org.slug, r.name)} className="break-all font-medium hover:underline">
                {r.name}
              </Link>
              <VisibilityBadge visibility={r.visibility} />
              <span className="font-mono text-xs text-ink-2">
                {r.tagCount} tags · {formatBytes(r.sizeBytes)}
              </span>
              <span className="ml-auto text-xs text-ink-3">
                {r.lastPushedAt ? `pushed ${relativeTime(r.lastPushedAt)}` : "empty"}
              </span>
              <form action={adminDeleteRepository}>
                <input type="hidden" name="repositoryId" value={r.id} />
                <input type="hidden" name="organizationId" value={org.id} />
                <button
                  type="submit"
                  aria-label={`Delete ${r.name}`}
                  className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                >
                  <Trash2 className="size-4" />
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
