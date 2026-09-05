import Link from "next/link";
import { Container, Globe } from "lucide-react";
import type { RepoListItem } from "@/lib/data";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { repoHref } from "@/lib/proxy-shared";
import { StarCount } from "@/components/star-button";

/** Repository listing used on org pages and the explore page. */
export function RepoTable({ repos, showOrg = false }: { repos: RepoListItem[]; showOrg?: boolean }) {
  if (repos.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card shadow-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Repository</th>
            <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">
              Tags
            </th>
            <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">
              Size
            </th>
            <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 md:table-cell">
              Pulls
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Last push</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => {
            const path = showOrg && repo.orgSlug ? `${repo.orgSlug}/${repo.name}` : repo.name;
            const href = repoHref(repo.orgSlug ?? "", repo.name);
            return (
              <tr key={repo.id} className="border-b border-line last:border-0 hover:bg-card-2">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    {repo.proxy ? (
                      <Globe className="size-4 shrink-0 text-accent" />
                    ) : (
                      <Container className="size-4 shrink-0 text-ink-3" />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={href} className="min-w-0 truncate font-medium text-ink hover:underline">
                          {path}
                        </Link>
                        <VisibilityBadge visibility={repo.visibility} />
                        <StarCount count={repo.starCount} />
                        {repo.proxy && (
                          <Badge
                            tone="accent"
                            title={repo.lastCheckedAt ? `Upstream checked ${relativeTime(repo.lastCheckedAt)}` : "Pull-through cache"}
                          >
                            cached{repo.lastCheckedAt ? ` · checked ${relativeTime(repo.lastCheckedAt)}` : ""}
                          </Badge>
                        )}
                      </div>
                      {repo.description && (
                        <div className="mt-0.5 truncate text-xs text-ink-2">{repo.description}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 sm:table-cell">
                  {repo.tagCount}
                </td>
                <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 sm:table-cell">
                  {formatBytes(repo.sizeBytes)}
                </td>
                <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 md:table-cell">
                  {formatCount(repo.pullCount)}
                </td>
                <td className="px-4 py-3 text-right text-[13px] text-ink-2">
                  {repo.lastPushedAt ? relativeTime(repo.lastPushedAt) : "never"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
