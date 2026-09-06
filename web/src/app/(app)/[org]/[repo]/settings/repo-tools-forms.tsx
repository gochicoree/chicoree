"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameRepository, transferRepository } from "@/app/actions/repo-tools";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, FieldAction, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { repoNameProblem } from "@/lib/repo-names-shared";
import { imagePath, imageReference } from "@/lib/library-shared";

export interface TransferTarget {
  id: string;
  name: string;
  slug: string;
}

function pullRef(registryHost: string, orgSlug: string, name: string): string {
  return imageReference(registryHost, orgSlug, name);
}

/** Rename within the organization; the old name keeps working for pulls. */
export function RepoRenameForm({
  repositoryId,
  orgSlug,
  name,
  registryHost,
  proxy,
  formerNames,
}: {
  repositoryId: string;
  orgSlug: string;
  name: string;
  registryHost: string;
  /** Proxy caches mirror upstream names: renaming is disabled. */
  proxy: boolean;
  formerNames: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = useState(name);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const next = value.trim();
  const problem = next === name ? null : repoNameProblem(next, false);
  const ready = next !== name && !problem;

  function confirm() {
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("name", next);
    start(async () => {
      const res = await renameRepository(data);
      if (res.error || !res.href) {
        setError(res.error ?? "Could not rename the repository.");
        setOpen(false);
        return;
      }
      toast({ title: `Renamed to ${imagePath(orgSlug, next)}`, description: `docker pull ${res.pullReference}. The old name keeps working for pulls.` });
      setOpen(false);
      router.push(`${res.href}/settings/danger`);
      router.refresh();
    });
  }

  return (
    <>
      <Card>
        <CardHeader
          eyebrow="Rename"
          title="Rename this repository"
          description={
            proxy
              ? "Repositories in a proxy cache mirror upstream names and cannot be renamed."
              : "Pulls and links using the old name keep working; pushes to it are refused."
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-64 flex-1 sm:flex-none">
              <Field label="New name" htmlFor="rename-name" hint={`Images will be pulled as ${pullRef(registryHost, orgSlug, next || "<name>")}:<tag>`}>
                <Input
                  id="rename-name"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                  disabled={proxy}
                  className="font-mono"
                  autoComplete="off"
                />
              </Field>
            </div>
            <FieldAction>
              <Button type="button" variant="secondary" disabled={proxy || !ready || busy} onClick={() => setOpen(true)}>
                Rename…
              </Button>
            </FieldAction>
          </div>
          {problem && next !== "" && <p className="text-sm text-danger">{problem}</p>}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {formerNames.length > 0 && (
            <p className="text-xs text-ink-2">
              Former names still redirecting here: <span className="font-mono">{formerNames.join(", ")}</span>.
            </p>
          )}
        </CardBody>
      </Card>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="accent"
        confirmLabel={busy ? "Renaming…" : `Rename to ${next}`}
        title={`Rename ${name} to ${next}?`}
        description="What changes:"
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>
            New reference: <code className="font-mono text-ink">docker pull {pullRef(registryHost, orgSlug, next)}:&lt;tag&gt;</code>
          </li>
          <li>
            <code className="font-mono">{imagePath(orgSlug, name)}</code> keeps working for <strong>pulls</strong> (and tag lists) through a redirect; a push or delete against it is refused with the new name.
          </li>
          <li>Bookmarks and links to the old web address redirect to the new one.</li>
          <li>Tags, scans, webhooks, mirrors, tag rules and retention settings stay as they are. CI pipelines pushing to the old name must be updated.</li>
          <li>The old name becomes free again as soon as a new repository is created with it.</li>
        </ul>
      </ConfirmModal>
    </>
  );
}

/** Move the repository into another organization the user manages. */
export function RepoTransferForm({
  repositoryId,
  orgSlug,
  orgName,
  name,
  registryHost,
  targets,
  proxy,
}: {
  repositoryId: string;
  orgSlug: string;
  orgName: string;
  name: string;
  registryHost: string;
  targets: TransferTarget[];
  proxy: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [targetId, setTargetId] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const target = targets.find((t) => t.id === targetId) ?? null;

  function confirm() {
    if (!target) return;
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("targetOrganizationId", target.id);
    start(async () => {
      const res = await transferRepository(data);
      if (res.error || !res.href) {
        setError(res.error ?? "Could not transfer the repository.");
        setOpen(false);
        return;
      }
      toast({ title: `Moved to ${imagePath(target.slug, name)}`, description: `docker pull ${res.pullReference}. The old name keeps working for pulls.` });
      setOpen(false);
      router.push(res.href);
      router.refresh();
    });
  }

  return (
    <>
      <Card>
        <CardHeader
          eyebrow="Transfer"
          title="Move to another organization"
          description={
            proxy
              ? "Repositories in a proxy cache cannot be moved."
              : "You need to be an owner or admin of both organizations."
          }
        />
        <CardBody className="space-y-3">
          {targets.length === 0 && !proxy ? (
            <p className="text-sm text-ink-2">You don't manage another organization to move it to.</p>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-64 flex-1 sm:flex-none">
                <Field label="Target organization" htmlFor="transfer-target">
                  <Select
                    id="transfer-target"
                    options={targets.map((t) => ({ value: t.id, label: t.name, description: imagePath(t.slug, name) }))}
                    value={targetId}
                    onChange={(v) => {
                      setTargetId(v);
                      setError(null);
                    }}
                    disabled={proxy}
                    placeholder="Choose an organization…"
                  />
                </Field>
              </div>
              <FieldAction>
                <Button type="button" variant="secondary" disabled={proxy || !target || busy} onClick={() => setOpen(true)}>
                  Transfer…
                </Button>
              </FieldAction>
            </div>
          )}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        </CardBody>
      </Card>
      {target && (
        <ConfirmModal
          open={open}
          onClose={() => setOpen(false)}
          onConfirm={confirm}
          busy={busy}
          tone="accent"
          confirmLabel={busy ? "Moving…" : `Move to ${target.name}`}
          title={`Move ${name} to ${target.name}?`}
          description="What changes:"
        >
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
            <li>
              New reference: <code className="font-mono text-ink">docker pull {pullRef(registryHost, target.slug, name)}:&lt;tag&gt;</code>
            </li>
            <li>
              <code className="font-mono">{imagePath(orgSlug, name)}</code> keeps working for <strong>pulls</strong> through a redirect; pushes and deletes against it are refused with the new name.
            </li>
            <li>
              Members of <strong>{target.name}</strong> get access according to their roles there; members of {orgName} lose access unless the repository is public. Service accounts of {orgName} restricted to this repository lose it.
            </li>
            <li>
              Tag rules, retention policy, webhooks, mirrors and scans <em>of the repository</em> move with it. Organization-wide rules, retention defaults, webhooks and the pull policy of {orgName} no longer apply; those of {target.name} do (the pull policy is re-evaluated after the move).
            </li>
            <li>{target.name}&apos;s repository and storage quotas are checked first; layers it already holds are not counted twice.</li>
          </ul>
        </ConfirmModal>
      )}
    </>
  );
}
