"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Trash2 } from "lucide-react";
import { deleteTagAction } from "@/app/actions/repositories";
import { deleteManifestAction } from "@/app/actions/manifests";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

/** Trash button with confirmation for one tag row; managers only (checked server-side too). */
export function DeleteTagButton({
  repositoryId,
  tag,
  latestFollows,
  protectedBy,
}: {
  repositoryId: string;
  tag: string;
  /** "latest" points at this tag's image and will move to the newest remaining one. */
  latestFollows: boolean;
  /** Pattern of the protected rule covering the tag: the button is shown locked. */
  protectedBy?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  if (protectedBy) {
    return (
      <span
        className="inline-flex rounded-md p-1.5 text-ink-3 opacity-60 pointer-coarse:p-2"
        title={`Protected by rule "${protectedBy}": this tag cannot be deleted`}
        aria-label={`Tag ${tag} is protected`}
      >
        <ShieldCheck className="size-4" />
      </span>
    );
  }

  function confirm() {
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("tag", tag);
    start(async () => {
      const res = await deleteTagAction(data);
      if (res.error || !res.outcome) {
        toast({ title: `Could not delete ${tag}`, description: res.error, tone: "error", duration: 8000 });
      } else {
        const { latest, latestTarget } = res.outcome;
        toast({
          title: `Deleted ${tag}`,
          description:
            latest === "moved"
              ? `latest now points at ${latestTarget}.`
              : latest === "removed"
                ? "latest was removed too: no images are left."
                : undefined,
        });
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Delete tag ${tag}`}
        className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer pointer-coarse:p-2"
      >
        <Trash2 className="size-4" />
      </button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Deleting…" : "Delete tag"}
        title={`Delete ${tag}?`}
        description={
          latestFollows
            ? `Removes the tag; the image data stays until untagged manifests are pruned. "latest" currently points at this image and will move to the newest remaining tag.`
            : "Removes the tag; the image data stays until untagged manifests are pruned."
        }
      />
    </>
  );
}

/**
 * Delete an image by digest, with every tag that points at it. `blocked`
 * (a protected tag, a still-existing parent index) disables the button and
 * explains why. Managers only; checked server-side too.
 */
export function DeleteManifestButton({
  repositoryId,
  digest,
  tags,
  blocked,
  variant = "icon",
  afterDelete,
}: {
  repositoryId: string;
  digest: string;
  /** Tags currently pointing at the digest (listed in the confirmation). */
  tags: string[];
  blocked?: string | null;
  variant?: "icon" | "button";
  /** Navigate here once the image is gone (the tag page has nothing left to show). */
  afterDelete?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const shortDigest = digest.slice(7, 19);

  function confirm() {
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("digest", digest);
    start(async () => {
      const res = await deleteManifestAction(data);
      if (res.error || !res.outcome) {
        toast({ title: `Could not delete ${shortDigest}`, description: res.error, tone: "error", duration: 8000 });
        setOpen(false);
        router.refresh();
        return;
      }
      toast({
        title: `Deleted image ${shortDigest}`,
        description: res.outcome.tags.length
          ? `Removed with it: ${res.outcome.tags.join(", ")}. Layer data is reclaimed by garbage collection.`
          : "Layer data is reclaimed by the next garbage collection.",
      });
      setOpen(false);
      if (afterDelete) router.push(afterDelete);
      router.refresh();
    });
  }

  const trigger =
    variant === "button" ? (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={!!blocked} title={blocked ?? undefined}>
        <Trash2 className="size-3.5" /> Delete image
      </Button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!!blocked}
        title={blocked ?? undefined}
        aria-label={`Delete image ${shortDigest}`}
        className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-3 pointer-coarse:p-2"
      >
        <Trash2 className="size-4" />
      </button>
    );

  return (
    <>
      {trigger}
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        tone="danger"
        confirmLabel={busy ? "Deleting…" : "Delete image"}
        title={`Delete image ${shortDigest}?`}
        description={
          tags.length > 0
            ? "The manifest is removed from the registry together with every tag that points at it. Layer data stays until garbage collection runs."
            : "The untagged manifest is removed from the registry. Layer data stays until garbage collection runs."
        }
      >
        {tags.length > 0 && (
          <div>
            <div className="eyebrow mb-1.5">Tags that will be removed ({tags.length})</div>
            <ul className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <li key={t} className="rounded-md bg-danger-soft px-2 py-0.5 font-mono text-[13px] text-danger">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmModal>
    </>
  );
}
