"use client";

// The administrator's bulk move screen: pick a target organization, select
// repositories from every repository on the instance, preview exactly what
// would happen, then confirm and watch the run. Nothing is written until the
// confirmation; the preview only reads.
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { previewBulkMove, runBulkMove, type BulkMovePreview, type BulkMoveRun } from "@/app/actions/bulk-move";
import { MAX_BULK_MOVE, skipLabel } from "@/lib/repo-move-shared";
import { formatBytes } from "@/lib/format";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { imagePath } from "@/lib/library-shared";

export interface MoveOrgOption {
  id: string;
  name: string;
  slug: string;
  /** A proxy cache: it can neither give up nor receive repositories. */
  proxy: boolean;
}

export interface MoveRepoOption {
  id: string;
  name: string;
  organizationId: string;
  orgSlug: string;
  orgName: string;
  visibility: "public" | "private";
  sizeBytes: number;
  tagCount: number;
  proxy: boolean;
}

/** "1 repository" / "3 repositories". */
function repoCount(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

function limitText(used: number, limit: number | null | undefined): string {
  return limit === null || limit === undefined ? String(used) : `${used} / ${limit}`;
}

export function BulkMoveForm({
  organizations,
  repositories,
  registryHost,
}: {
  organizations: MoveOrgOption[];
  repositories: MoveRepoOption[];
  registryHost: string;
}) {
  const { toast } = useToast();
  const [targetId, setTargetId] = useState("");
  const [orgFilter, setOrgFilter] = useState("all");
  const [query, setQuery] = useState("");
  // An array, not a Set: the run follows the order the administrator picked.
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<BulkMovePreview | null>(null);
  const [run, setRun] = useState<BulkMoveRun | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, start] = useTransition();

  const target = organizations.find((o) => o.id === targetId) ?? null;
  const chosen = useMemo(() => new Set(selected), [selected]);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      repositories.filter(
        (r) =>
          (orgFilter === "all" || r.organizationId === orgFilter) &&
          (needle === "" || r.name.toLowerCase().includes(needle) || `${r.orgSlug}/${r.name}`.toLowerCase().includes(needle)),
      ),
    [repositories, orgFilter, needle],
  );
  /** Repositories already in the target cannot move; they are never selectable. */
  const selectable = visible.filter((r) => r.organizationId !== targetId);
  const tooMany = selected.length > MAX_BULK_MOVE;
  const ready = !!target && selected.length > 0 && !tooMany;

  function reset() {
    setPreview(null);
    setRun(null);
  }

  function toggle(id: string) {
    reset();
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function pickTarget(id: string) {
    reset();
    setTargetId(id);
    // Anything already in the new target cannot move; drop it silently.
    setSelected((prev) => prev.filter((x) => repositories.find((r) => r.id === x)?.organizationId !== id));
  }

  function selectAllShown() {
    reset();
    setSelected((prev) => [...prev, ...selectable.filter((r) => !prev.includes(r.id)).map((r) => r.id)]);
  }

  function clearSelection() {
    reset();
    setSelected([]);
  }

  function formData(): FormData {
    const data = new FormData();
    data.set("targetOrganizationId", targetId);
    for (const id of selected) data.append("repositoryIds", id);
    return data;
  }

  function doPreview() {
    setRun(null);
    start(async () => setPreview(await previewBulkMove(formData())));
  }

  function doRun() {
    start(async () => {
      const result = await runBulkMove(formData());
      setConfirmOpen(false);
      setRun(result);
      setPreview(null);
      if (result.error) return;
      setSelected(result.rows.filter((r) => !r.ok).map((r) => r.repositoryId));
      toast({
        title: result.failed === 0 ? `Moved ${repoCount(result.moved)}` : `Moved ${result.moved}, skipped ${result.failed}`,
        description: `${result.target?.slug}/ now serves them; the old names keep working for pulls.`,
        tone: result.failed === 0 ? "success" : "info",
      });
    });
  }

  const orgOptions = organizations.map((o) => ({
    value: o.id,
    label: o.name,
    description: o.proxy ? `${o.slug}/ — proxy cache, cannot receive repositories` : `${o.slug}/`,
  }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Step 1"
          title="Target organization"
          description="Where the selected repositories end up. Instance administrators may move any repository, regardless of membership."
        />
        <CardBody className="space-y-3">
          <div className="max-w-sm">
            <Field label="Move repositories into" htmlFor="bulk-move-target">
              <Select
                id="bulk-move-target"
                options={orgOptions}
                value={targetId}
                onChange={pickTarget}
                placeholder="Choose an organization…"
              />
            </Field>
          </div>
          {target?.proxy && (
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {target.name} is a proxy cache; only its upstream fills it. Every repository will be skipped.
            </p>
          )}
          {target && !target.proxy && (
            <p className="text-sm text-ink-2">
              Images will be pulled as <code className="font-mono text-ink">{registryHost}/{imagePath(target.slug, "<name>")}</code>.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Step 2"
          title={`Repositories (${selected.length} selected)`}
          description={`Every repository on the instance. A single run moves at most ${MAX_BULK_MOVE}.`}
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <Field label="Organization" htmlFor="bulk-move-filter">
                <Select
                  id="bulk-move-filter"
                  options={[
                    { value: "all", label: "All organizations", description: `${repositories.length} repositories` },
                    ...organizations.map((o) => ({
                      value: o.id,
                      label: o.name,
                      description: `${repositories.filter((r) => r.organizationId === o.id).length} in ${o.slug}/`,
                    })),
                  ]}
                  value={orgFilter}
                  onChange={setOrgFilter}
                />
              </Field>
            </div>
            <div className="relative w-full sm:w-56">
              <Field label="Name" htmlFor="bulk-move-search">
                <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-3.5 text-ink-3" />
                <Input
                  id="bulk-move-search"
                  placeholder="Filter by name…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-8"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={selectAllShown} disabled={selectable.length === 0}>
                {orgFilter === "all" ? `Select all shown (${selectable.length})` : `Select all in ${organizations.find((o) => o.id === orgFilter)?.slug ?? "organization"} (${selectable.length})`}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={clearSelection} disabled={selected.length === 0}>
                Clear
              </Button>
            </div>
          </div>
        </CardBody>

        {visible.length === 0 ? (
          <p className="border-t border-line px-4 py-4 text-sm text-ink-3 sm:px-5">No repository matches the filter.</p>
        ) : (
          <div className="border-t border-line">
            {visible.map((r) => {
              const inTarget = r.organizationId === targetId;
              return (
                <label
                  key={r.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-sm last:border-0 sm:px-5 ${
                    inTarget ? "opacity-55" : "cursor-pointer hover:bg-card-2"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--action)]"
                    checked={chosen.has(r.id)}
                    disabled={inTarget}
                    onChange={() => toggle(r.id)}
                  />
                  <span className="min-w-0 break-all font-medium">
                    <span className="font-mono text-ink-2">{r.orgSlug}/</span>
                    {r.name}
                  </span>
                  <VisibilityBadge visibility={r.visibility} />
                  {r.proxy && <Badge tone="neutral">proxy</Badge>}
                  {inTarget && <Badge tone="neutral">already there</Badge>}
                  <span className="ml-auto whitespace-nowrap font-mono text-xs text-ink-3">
                    {r.tagCount} tags · {formatBytes(r.sizeBytes)}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <CardBody className="flex flex-wrap items-center gap-3 border-t border-line">
          <Button type="button" onClick={doPreview} disabled={!ready || busy}>
            {busy && !confirmOpen ? "Checking…" : "Preview…"}
          </Button>
          {!target && <span className="text-sm text-ink-3">Choose a target organization first.</span>}
          {tooMany && (
            <span className="text-sm text-danger">
              One run moves at most {MAX_BULK_MOVE} repositories ({selected.length} selected). Move them in smaller batches so quota
              accounting stays correct.
            </span>
          )}
        </CardBody>
      </Card>

      {preview && <PreviewCard preview={preview} busy={busy} onConfirm={() => setConfirmOpen(true)} />}
      {run && <RunCard run={run} registryHost={registryHost} />}

      {preview?.target && (
        <ConfirmModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={doRun}
          busy={busy}
          confirmLabel={`Move ${repoCount(preview.movable)}`}
          title={`Move ${repoCount(preview.movable)} into ${preview.target.name}?`}
          description="What changes:"
        >
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
            <li>
              New references: <code className="font-mono text-ink">docker pull {registryHost}/{imagePath(preview.target.slug, "<name>")}:&lt;tag&gt;</code>
            </li>
            <li>
              Each old <code className="font-mono">org/name</code> keeps working for <strong>pulls</strong> (and tag lists) through a
              redirect; a <strong>push</strong> or delete against the old name is refused with the new name.
            </li>
            <li>
              Organization-scoped policies of the source no longer apply: pull policies, organization-wide tag rules and retention
              settings are {preview.target.name}&apos;s now. Rules attached to a repository move with it.
            </li>
            <li>Members of the source organization lose access unless they are members of {preview.target.name}.</li>
            <li>Tags, scans, webhooks, mirrors and stars stay as they are. CI pipelines pushing to the old names must be updated.</li>
            <li>
              The moves run one at a time and continue past failures; {preview.skipped > 0 ? `the ${preview.skipped} skipped ` : "skipped "}
              repositories are left where they are.
            </li>
          </ul>
        </ConfirmModal>
      )}
    </div>
  );
}

function PreviewCard({ preview, busy, onConfirm }: { preview: BulkMovePreview; busy: boolean; onConfirm: () => void }) {
  if (preview.error) {
    return (
      <Card>
        <CardHeader eyebrow="Step 3" title="Preview" />
        <CardBody>
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{preview.error}</p>
        </CardBody>
      </Card>
    );
  }
  const { usage, limits, resulting, target } = preview;
  return (
    <Card>
      <CardHeader
        eyebrow="Step 3"
        title={`Preview: ${preview.movable} move, ${preview.skipped} skipped`}
        description={`Nothing has been written. ${formatBytes(preview.totalBytesNew)} of blobs are new to ${target?.name ?? "the target"}; layers it already holds cost nothing.`}
      />
      <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Storage after"
          value={formatBytes(resulting?.storageBytes ?? 0)}
          detail={`now ${formatBytes(usage?.storageBytes ?? 0)}${limits?.maxStorageBytes != null ? ` · limit ${formatBytes(limits.maxStorageBytes)}` : " · no limit"}`}
        />
        <Stat
          label="Public repositories after"
          value={limitText(resulting?.publicRepos ?? 0, limits?.maxPublicRepos)}
          detail={`now ${usage?.publicRepos ?? 0}`}
        />
        <Stat
          label="Private repositories after"
          value={limitText(resulting?.privateRepos ?? 0, limits?.maxPrivateRepos)}
          detail={`now ${usage?.privateRepos ?? 0}`}
        />
      </CardBody>
      <OutcomeTable rows={preview.rows} verb="will move" />
      <CardBody className="flex flex-wrap items-center gap-3 border-t border-line">
        <Button type="button" onClick={onConfirm} disabled={preview.movable === 0 || busy}>
          Move {repoCount(preview.movable)}…
        </Button>
        {preview.movable === 0 && <span className="text-sm text-ink-3">Nothing in this selection can move.</span>}
      </CardBody>
    </Card>
  );
}

function RunCard({ run, registryHost }: { run: BulkMoveRun; registryHost: string }) {
  if (run.error) {
    return (
      <Card>
        <CardHeader eyebrow="Result" title="Nothing moved" />
        <CardBody>
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{run.error}</p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        eyebrow="Result"
        title={`${run.moved} moved, ${run.failed} skipped`}
        description={`${formatBytes(run.bytesMoved)} of blobs are new to ${run.target?.name ?? "the target"}. Old names keep serving pulls: docker pull ${registryHost}/<old-org>/<name>.`}
      />
      <OutcomeTable rows={run.rows} verb="moved" targetSlug={run.target?.slug} />
    </Card>
  );
}

function OutcomeTable({
  rows,
  verb,
  targetSlug,
}: {
  rows: BulkMovePreview["rows"];
  verb: "will move" | "moved";
  targetSlug?: string;
}) {
  if (rows.length === 0) return <p className="border-t border-line px-4 py-4 text-sm text-ink-3 sm:px-5">Nothing selected.</p>;
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Repository</th>
            <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">New bytes</th>
            <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.repositoryId} className="border-b border-line last:border-0">
              <td className="px-4 py-3 sm:px-5">
                <span className="break-all font-medium">
                  <span className="font-mono text-ink-2">{r.sourceSlug}/</span>
                  {r.name || r.repositoryId}
                </span>
                <div className="text-xs text-ink-3">{r.visibility}</div>
              </td>
              <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 sm:table-cell">
                {r.ok ? formatBytes(r.bytesNew) : "—"}
              </td>
              <td className="px-4 py-3">
                <Badge tone={r.ok ? "ok" : "danger"}>{r.ok ? verb : skipLabel(r.code)}</Badge>
                {r.message && <div className="mt-1 max-w-md text-xs text-ink-2">{r.message}</div>}
                {r.ok && verb === "moved" && targetSlug && (
                  <div className="mt-1 text-xs">
                    <Link href={`/${targetSlug}/${r.name}`} className="text-action hover:underline">
                      {imagePath(targetSlug, r.name)}
                    </Link>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-line bg-card-2 px-3 py-2.5">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="font-mono text-base tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{detail}</div>
    </div>
  );
}
