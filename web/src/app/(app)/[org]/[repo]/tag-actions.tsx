"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteTagAction } from "@/app/actions/repositories";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

/** Trash button with confirmation for one tag row; managers only (checked server-side too). */
export function DeleteTagButton({
  repositoryId,
  tag,
  latestFollows,
}: {
  repositoryId: string;
  tag: string;
  /** "latest" points at this tag's image and will move to the newest remaining one. */
  latestFollows: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

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
