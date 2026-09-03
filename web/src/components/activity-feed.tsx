import Link from "next/link";
import { ArrowUpFromLine, Trash2 } from "lucide-react";
import type { ActivityItem } from "@/lib/data";
import { relativeTime, shortDigest } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";

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
            className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
              item.type === "push" ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"
            }`}
          >
            {item.type === "push" ? <ArrowUpFromLine className="size-3.5" /> : <Trash2 className="size-3.5" />}
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-snug [overflow-wrap:anywhere]">
            <span className="text-ink-2">{item.actorName ?? (item.actorType === "proxy" ? "proxy cache" : item.actorType === "mirror" ? "mirror" : "someone")}</span>{" "}
            <span className="text-ink-2">{item.type === "push" ? (item.actorType === "proxy" ? "cached" : "pushed") : "deleted"}</span>{" "}
            <Link href={activityHref(item.repoPath)} className="font-medium text-ink hover:underline">
              {item.repoPath}
            </Link>
            {item.tag ? (
              <span className="font-mono text-ink-2">:{item.tag}</span>
            ) : item.digest ? (
              <span className="font-mono text-ink-3"> @{shortDigest(item.digest, 8)}</span>
            ) : null}
          </div>
          <span className="shrink-0 pt-0.5 text-xs text-ink-3">{relativeTime(item.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
