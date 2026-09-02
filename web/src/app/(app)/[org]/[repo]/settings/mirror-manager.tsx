"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { GitMerge, Play, Trash2 } from "lucide-react";
import { deleteMirror, previewMirror, runMirrorNow, saveMirror, type MirrorResult } from "@/app/actions/mirrors";
import type { MirrorLogEntry, Relabel, TagSelector } from "@/db/schema";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MirrorFormFields } from "@/components/mirror-form-fields";
import { relativeTime } from "@/lib/format";

export interface MirrorView {
  id: string;
  source: string;
  hasAuth: boolean;
  selector: TagSelector;
  relabel: Relabel;
  overwrite: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runs: {
    id: string;
    status: string;
    matched: number;
    imported: number;
    skipped: number;
    failed: number;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
    log: MirrorLogEntry[];
  }[];
}

export function MirrorManager({ repositoryId, mirror }: { repositoryId: string; mirror: MirrorView | null }) {
  const [state, action, pending] = useActionState<MirrorResult | null, FormData>(saveMirror, null);
  const [preview, previewAction, previewing] = useActionState<MirrorResult | null, FormData>(previewMirror, null);
  const router = useRouter();
  const running = mirror?.runs.some((r) => r.status === "running") ?? false;

  // Imports run in the background; poll while one is in flight so the log
  // and counters update without a manual reload.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [running, router]);

  return (
    <Card>
      <CardHeader
        eyebrow="Mirror"
        title={mirror ? `Mirroring ${mirror.source}` : "Mirror another registry"}
        description="Import matching tags from a source repository into this one. Run it manually, from the mirror-sync job, or via the jobs API on a schedule."
        action={
          mirror && (
            <div className="flex items-center gap-2">
              {mirror.lastStatus && (
                <Badge tone={mirror.lastStatus === "succeeded" ? "ok" : "danger"}>
                  {mirror.lastStatus} · {relativeTime(mirror.lastRunAt)}
                </Badge>
              )}
              <form action={runMirrorNow}>
                <input type="hidden" name="repositoryId" value={repositoryId} />
                <Button type="submit" size="sm" variant="accent" disabled={running}>
                  <Play className="size-3.5" /> {running ? "Syncing…" : "Sync now"}
                </Button>
              </form>
            </div>
          )
        }
      />
      <CardBody>
        <form className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="repositoryId" value={repositoryId} />
          <MirrorFormFields
            source={mirror?.source}
            selector={mirror?.selector}
            relabel={mirror?.relabel}
            hasStoredAuth={mirror?.hasAuth}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="overwrite" defaultChecked={mirror?.overwrite ?? true} className="size-4 accent-[var(--action)]" />
            Re-import changed tags
          </label>
          {mirror && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" name="enabled" value="on" defaultChecked={mirror.enabled} className="size-4 accent-[var(--action)]" />
              <input type="hidden" name="enabled" value="off" />
              Included in scheduled syncs
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" formAction={action} disabled={pending}>
              <GitMerge className="size-4" /> {mirror ? "Save mirror" : "Configure mirror"}
            </Button>
            <Button type="submit" variant="secondary" formAction={previewAction} formNoValidate disabled={previewing}>
              {previewing ? "Checking…" : "Preview matching tags"}
            </Button>
            {state?.saved && <span className="text-sm text-ok">Saved.</span>}
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
            {preview?.error && <span className="text-sm text-danger">{preview.error}</span>}
            {preview?.preview && (
              <span className="text-sm text-ink-2">
                {preview.preview.matched.length} of {preview.preview.total} tags match
              </span>
            )}
          </div>
          {preview?.preview && preview.preview.matched.length > 0 && (
            <div className="flex flex-wrap gap-1.5 sm:col-span-2">
              {preview.preview.matched.map((t) => (
                <span key={t} className="rounded-md bg-card-2 px-2 py-0.5 font-mono text-xs">
                  {t}
                </span>
              ))}
            </div>
          )}
        </form>

        {mirror && (
          <div className="mt-6 border-t border-line pt-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="eyebrow">Recent runs</div>
              <form action={deleteMirror}>
                <input type="hidden" name="repositoryId" value={repositoryId} />
                <Button type="submit" variant="ghost" size="sm">
                  <Trash2 className="size-3.5" /> Remove mirror
                </Button>
              </form>
            </div>
            {mirror.runs.length === 0 ? (
              <p className="text-sm text-ink-3">No runs yet.</p>
            ) : (
              <div className="space-y-2">
                {mirror.runs.map((run) => (
                  <details key={run.id} className="rounded-lg border border-line bg-card-2 px-3 py-2">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                      <Badge tone={run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "neutral"}>{run.status}</Badge>
                      <span className="font-mono text-xs text-ink-2">
                        {run.matched} matched · {run.imported} imported · {run.skipped} skipped · {run.failed} failed
                      </span>
                      {run.error && <span className="text-xs text-danger">{run.error}</span>}
                      <span className="ml-auto text-xs text-ink-3">{relativeTime(run.startedAt)}</span>
                    </summary>
                    <div className="mt-2 space-y-0.5 font-mono text-xs">
                      {run.log.map((e, i) => (
                        <div key={i} className="flex flex-wrap gap-x-2">
                          <span className={e.status === "imported" ? "text-ok" : e.status === "failed" ? "text-danger" : "text-ink-3"}>
                            {e.status}
                          </span>
                          <span>
                            {e.sourceTag} → {e.targetTag}
                          </span>
                          {e.detail && <span className="text-ink-3">{e.detail}</span>}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
