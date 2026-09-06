import Link from "next/link";
import { ArrowUpFromLine, Trash2 } from "lucide-react";
import type { ActivityItem } from "@/lib/data";
import { relativeTime, shortDigest } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { EntityLogo } from "@/components/entity-logo";
import { logoRef } from "@/lib/logo-shared";
import { displayPath } from "@/lib/library-shared";

function activityHref(repoPath: string): string {
  const slash = repoPath.indexOf("/");
  return slash < 0 ? `/${repoPath}` : repoHref(repoPath.slice(0, slash), repoPath.slice(slash + 1));
}

/** Recent pushes and deletions across the caller's scope. */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
        Push an image and activity will show up here.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-card-2">
          <span
            className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${
              item.type === "push" ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"
            }`}
          >
            {item.type === "push" ? <ArrowUpFromLine className="size-3.5" /> : <Trash2 className="size-3.5" />}
          </span>
          {/* A wrapping flex row keeps avatar, name, verb and image on one vertical centre line; a narrow column wraps whole tokens. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1 text-[13px] leading-snug [overflow-wrap:anywhere]">
            {item.actorUserId ? (
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <EntityLogo
                  kind="user"
                  name={item.actorName ?? ""}
                  logo={logoRef("user", item.actorUserId, item.actorLogoVersion)}
                  size={16}
                />
                {item.actorName}
              </span>
            ) : (
              <span className="text-ink-2">{item.actorName ?? (item.actorType === "proxy" ? "proxy cache" : item.actorType === "mirror" ? "mirror" : "someone")}</span>
            )}
            <span className="text-ink-2">{item.type === "push" ? (item.actorType === "proxy" ? "cached" : "pushed") : "deleted"}</span>
            <span className="min-w-0">
              <Link href={activityHref(item.repoPath)} className="font-medium text-ink hover:underline">
                {displayPath(item.repoPath)}
              </Link>
              {item.tag ? (
                <span className="font-mono text-ink-2">:{item.tag}</span>
              ) : item.digest ? (
                <span className="font-mono text-ink-3"> @{shortDigest(item.digest, 8)}</span>
              ) : null}
            </span>
          </div>
          <span className="shrink-0 py-1 text-xs leading-snug text-ink-3">{relativeTime(item.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
