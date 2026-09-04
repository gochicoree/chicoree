"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { rescanEverything, type ScannerActionResult } from "@/app/actions/scanning";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

/** Queues scan-stale with olderThan=0s after a confirmation. */
export function RescanButton({ images, disabled }: { images: number; disabled: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, action, pending] = useActionState<ScannerActionResult | null, FormData>(rescanEverything, null);
  const [open, setOpen] = useState(false);
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.error) toast({ title: state.error, tone: "error" });
    else if (state?.message) {
      toast({ title: "Re-scan queued", description: state.message, tone: "success" });
      setOpen(false);
      router.refresh();
    }
  }, [state, toast, router]);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" disabled={disabled || pending} onClick={() => setOpen(true)} title={disabled ? "Pick a scanner backend first" : undefined}>
        <RotateCw className="size-3.5" /> Re-scan everything
      </Button>
      <ConfirmModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => action(new FormData())}
        title="Re-scan every tagged image?"
        description={`Queues the scan-stale job with olderThan=0s: up to 500 images per run (${images} tagged single-platform images right now) are scanned again in the background, one after the other.`}
        confirmLabel={pending ? "Queueing…" : "Re-scan everything"}
        busy={pending}
      />
    </>
  );
}
