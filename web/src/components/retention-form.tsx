"use client";

import { startTransition, useActionState, useState } from "react";
import { Eye, Play } from "lucide-react";
import {
  previewRetention,
  runRetentionNow,
  saveRetentionPolicy,
  type RetentionActionResult,
  type RetentionPreview,
  type RetentionRunSummary,
} from "@/app/actions/retention";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { useActionToast } from "@/components/ui/toast";
import { describeRetention, type RetentionSettings } from "@/lib/retention-shared";

function short(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice(7, 19) : digest;
}

function PreviewView({ preview, scope }: { preview: RetentionPreview; scope: "organization" | "repository" }) {
  const totalTags = preview.repositories.reduce((n, r) => n + r.tags.length, 0);
  const totalManifests = preview.repositories.reduce((n, r) => n + r.manifests.length, 0);
  if (preview.repositories.length === 0) {
    return (
      <p className="rounded-md bg-card-2 px-3 py-2 text-sm text-ink-2">
        {scope === "organization"
          ? "No repository in this organization has an enabled retention policy."
          : "This repository has no enabled retention policy."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Right now this would delete <strong className="text-ink">{totalTags}</strong> tag{totalTags === 1 ? "" : "s"} and{" "}
        <strong className="text-ink">{totalManifests}</strong> untagged manifest{totalManifests === 1 ? "" : "s"}
        {scope === "organization" ? ` across ${preview.repositories.length} repositor${preview.repositories.length === 1 ? "y" : "ies"}` : ""}.
        Nothing has been deleted.
      </p>
      {preview.repositories.map((r) => (
        <div key={r.path} className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="font-mono text-[13px] font-medium">{r.path}</span>
            <span className="text-xs text-ink-3">
              {r.scope === "repository" ? "repository policy" : "organization policy"}: {r.policy}
            </span>
          </div>
          <div className="space-y-2 px-3 py-2 text-sm">
            {r.tags.length === 0 && r.manifests.length === 0 && <p className="text-ink-3">Nothing to delete.</p>}
            {r.tags.length > 0 && (
              <div>
                <div className="eyebrow mb-1">Tags to delete ({r.tags.length})</div>
                <ul className="space-y-0.5">
                  {r.tags.map((t) => (
                    <li key={t.name} className="flex flex-wrap gap-x-2 text-[13px]">
                      <span className="font-mono text-danger">{t.name}</span>
                      <span className="text-ink-3">{t.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r.manifests.length > 0 && (
              <div>
                <div className="eyebrow mb-1">Untagged manifests to delete ({r.manifests.length})</div>
                <ul className="space-y-0.5">
                  {r.manifests.map((m) => (
                    <li key={m.digest} className="flex flex-wrap gap-x-2 text-[13px]">
                      <span className="font-mono text-danger">{short(m.digest)}</span>
                      <span className="text-ink-3">{m.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(r.keptTags.length > 0 || r.keptManifests.length > 0) && (
              <details className="text-[13px]">
                <summary className="cursor-pointer text-ink-2">
                  Kept: {r.keptTags.length} tag{r.keptTags.length === 1 ? "" : "s"}, {r.keptManifests.length} untagged manifest
                  {r.keptManifests.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {r.keptTags.map((t) => (
                    <li key={t.name} className="flex flex-wrap gap-x-2">
                      <span className="font-mono">{t.name}</span>
                      <span className="text-ink-3">{t.reason}</span>
                    </li>
                  ))}
                  {r.keptManifests.map((m) => (
                    <li key={m.digest} className="flex flex-wrap gap-x-2">
                      <span className="font-mono">{short(m.digest)}</span>
                      <span className="text-ink-3">{m.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RunView({ run }: { run: RetentionRunSummary }) {
  const failed = run.tags.failed + run.manifests.failed;
  return (
    <div className="space-y-2">
      <p className={`rounded-md px-3 py-2 text-sm ${failed ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>
        Deleted {run.tags.deleted} tag{run.tags.deleted === 1 ? "" : "s"} and {run.manifests.deleted} untagged manifest
        {run.manifests.deleted === 1 ? "" : "s"} in {run.repositories} repositor{run.repositories === 1 ? "y" : "ies"}
        {failed ? `; ${failed} failed` : ""}. Layer data is reclaimed by the next garbage collection.
      </p>
      {run.detail.length > 0 && (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto text-[13px]">
          {run.detail.map((d, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2">
              <Badge tone={d.status === "failed" ? "danger" : "ok"}>{d.status}</Badge>
              <span className="font-mono text-ink-2">{d.repository}</span>
              <span className="font-mono">{d.kind === "manifest" ? short(d.ref) : d.ref}</span>
              <span className="text-ink-3">{d.error ?? d.reason}</span>
            </li>
          ))}
          {run.truncated > 0 && <li className="text-ink-3">… and {run.truncated} more (see the job run on the admin Jobs page)</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Retention card: the policy form with Save, a Preview that plans the form's
 * values without deleting, and Run now, which applies the saved policy
 * after confirmation.
 */
export function RetentionForm({
  scope,
  organizationId,
  repositoryId,
  policy,
  inherited,
}: {
  scope: "organization" | "repository";
  organizationId: string;
  repositoryId?: string;
  /** The scope's own saved policy, or null. */
  policy: RetentionSettings | null;
  /** Repository scope: the organization default it inherits without its own policy. */
  inherited?: RetentionSettings | null;
}) {
  const [saveState, saveAction, saving] = useActionState<RetentionActionResult | null, FormData>(saveRetentionPolicy, null);
  const [previewState, previewAction, previewing] = useActionState<RetentionActionResult | null, FormData>(previewRetention, null);
  const [runState, runAction, running] = useActionState<RetentionActionResult | null, FormData>(runRetentionNow, null);
  useActionToast(saveState, "Retention policy saved");
  const [mode, setMode] = useState<"inherit" | "custom">(scope === "repository" && !policy ? "inherit" : "custom");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const custom = mode === "custom";

  function runNow() {
    const data = new FormData();
    data.set("organizationId", organizationId);
    if (repositoryId) data.set("repositoryId", repositoryId);
    startTransition(() => runAction(data));
    setConfirmOpen(false);
  }

  const savedSummary = describeRetention(policy);

  return (
    <Card>
      <CardHeader
        eyebrow="Retention"
        title="Clean up old tags and images"
        description={
          scope === "organization"
            ? "The default for every repository in the organization; a repository with its own policy replaces it entirely. Protected tags are never deleted. Applied by the retention job — run it from the admin Jobs page or on a schedule."
            : "Replaces the organization's policy for this repository. Protected tags are never deleted. Applied by the retention job — run it from the admin Jobs page or on a schedule."
        }
      />
      <CardBody className="space-y-4">
        <form action={saveAction} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="organizationId" value={organizationId} />
          {repositoryId && <input type="hidden" name="repositoryId" value={repositoryId} />}
          <input type="hidden" name="mode" value={mode} />
          {scope === "repository" && (
            <div className="sm:col-span-2">
              <Field label="Policy" htmlFor="retention-mode">
                <Select
                  id="retention-mode"
                  value={mode}
                  onChange={(v) => setMode(v as "inherit" | "custom")}
                  options={[
                    {
                      value: "inherit",
                      label: `Inherit from the organization (${describeRetention(inherited)})`,
                      description: "Follow the organization-wide policy",
                    },
                    { value: "custom", label: "Custom policy for this repository", description: "Replaces the organization's policy entirely" },
                  ]}
                />
              </Field>
            </div>
          )}
          {custom && (
            <>
              <label className="flex items-start gap-2 text-sm text-ink-2 sm:col-span-2">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={policy?.enabled ?? false}
                  className="mt-0.5 size-4 accent-[var(--action)]"
                />
                <span>
                  Enabled
                  <span className="block text-xs text-ink-3">Only enabled policies are applied by the retention job; previews work either way.</span>
                </span>
              </label>
              <Field label="Keep the newest tags" htmlFor="retention-keep-last" hint="Number of most recently pushed tags that always stay.">
                <Input
                  id="retention-keep-last"
                  name="keepLast"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder="e.g. 10"
                  defaultValue={policy?.keepLast ?? ""}
                  className="font-mono"
                />
              </Field>
              <Field label="Always keep tags matching" htmlFor="retention-keep-matching" hint="Space-separated patterns, * and ? wildcards.">
                <Input
                  id="retention-keep-matching"
                  name="keepMatching"
                  placeholder="latest v*"
                  defaultValue={policy?.keepMatching ?? ""}
                  className="font-mono"
                />
              </Field>
              <Field
                label="Delete tags older than (days)"
                htmlFor="retention-older"
                hint="Counted from the tag's last push. Empty with a keep count: everything beyond the newest tags goes."
              >
                <Input
                  id="retention-older"
                  name="deleteOlderThanDays"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder="e.g. 90"
                  defaultValue={policy?.deleteOlderThanDays ?? ""}
                  className="font-mono"
                />
              </Field>
              <Field
                label="Delete untagged manifests after (days)"
                htmlFor="retention-untagged"
                hint="Images without a tag. Platform variants of an existing index and attached artifacts are skipped."
              >
                <Input
                  id="retention-untagged"
                  name="deleteUntaggedAfterDays"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder="e.g. 7"
                  defaultValue={policy?.deleteUntaggedAfterDays ?? ""}
                  className="font-mono"
                />
              </Field>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={saving || previewing}>
              {saving ? "Saving…" : "Save policy"}
            </Button>
            <Button type="submit" variant="secondary" formAction={previewAction} disabled={saving || previewing}>
              <Eye className="size-4" /> {previewing ? "Planning…" : "Preview"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={running}
              onClick={() => setConfirmOpen(true)}
              title="Applies the saved policy now"
            >
              <Play className="size-4" /> {running ? "Running…" : "Run now"}
            </Button>
            {saveState?.error && <span className="basis-full text-sm text-danger">{saveState.error}</span>}
            {previewState?.error && <span className="basis-full text-sm text-danger">{previewState.error}</span>}
            {runState?.error && <span className="basis-full text-sm text-danger">{runState.error}</span>}
          </div>
        </form>

        {previewState?.preview && (
          <div className="border-t border-line pt-4">
            <div className="eyebrow mb-2">Preview</div>
            <PreviewView preview={previewState.preview} scope={scope} />
          </div>
        )}
        {runState?.run && (
          <div className="border-t border-line pt-4">
            <div className="eyebrow mb-2">Last run</div>
            <RunView run={runState.run} />
          </div>
        )}
      </CardBody>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={runNow}
        busy={running}
        tone="danger"
        confirmLabel="Delete now"
        title={scope === "organization" ? "Apply retention to every repository?" : "Apply retention to this repository?"}
        description={
          scope === "organization" ? (
            <>
              Runs the <em>saved</em> organization policy now (repositories with their own policy use that), not a dry run: the tags and
              untagged manifests it selects are deleted through the registry. Use Preview first to see what would go. Organization policy:{" "}
              <strong>{savedSummary}</strong>.
            </>
          ) : (
            <>
              Runs the <em>saved</em> policy for this repository now, not a dry run: the tags and untagged manifests it selects are deleted
              through the registry. Use Preview first to see what would go. Effective policy: <strong>{savedSummary}</strong>.
            </>
          )
        }
      />
    </Card>
  );
}
