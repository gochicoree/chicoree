import Link from "next/link";
import { Braces } from "lucide-react";
import { dismissApiRevisionNotice } from "@/app/actions/api-revision";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button, buttonClasses } from "@/components/ui/button";
import type { RevisionNotice } from "@/lib/api/revision-notice";

/** Shown on the administration overview while the API revision is newer than the acknowledged one. */
export function ApiRevisionCard({ notice }: { notice: RevisionNotice }) {
  if (notice.unseen.length === 0) return null;
  return (
    <div data-api-revision-card>
    <Card className="mt-6">
      <CardHeader
        eyebrow="REST API"
        title={notice.acknowledged ? `The API changed: revision ${notice.current}` : `API revision ${notice.current}`}
        description={
          notice.acknowledged
            ? `Since ${notice.acknowledged}, the endpoints and documentation moved with the features. Clients should read the changelog before upgrading.`
            : "The API follows the registry's features; this card appears whenever the revision moves."
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/docs/api" className={buttonClasses("secondary", "sm")}>
              <Braces className="size-3.5" /> API docs
            </Link>
            <form action={dismissApiRevisionNotice}>
              <Button type="submit" variant="ghost" size="sm">
                Got it
              </Button>
            </form>
          </div>
        }
      />
      <CardBody>
        <div className="space-y-3">
          {notice.unseen.slice(0, 3).map((c) => (
            <div key={c.revision}>
              <div className="font-mono text-xs text-ink-2">{c.revision}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                {c.changes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
          {notice.unseen.length > 3 && <p className="text-xs text-ink-3">…and {notice.unseen.length - 3} older revisions; the full changelog is on the API page.</p>}
        </div>
      </CardBody>
    </Card>
    </div>
  );
}
