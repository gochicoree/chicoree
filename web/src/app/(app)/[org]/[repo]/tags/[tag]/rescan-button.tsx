"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { requestRescan } from "@/app/actions/repositories";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Queue a vulnerability scan and say what happened. Disabled while a scan
 * runs, while the request is in flight, right after one was queued (until
 * the page refreshes with the pending state) and for manifests that are
 * never scanned — with the reason as the tooltip.
 */
export function RescanButton({
  repositoryId,
  digest,
  running,
  disabledReason,
}: {
  repositoryId: string;
  digest: string;
  /** A scan is pending or indexing right now. */
  running: boolean;
  /** Why this manifest is never scanned (attestation, signature, SBOM); null when it can be. */
  disabledReason?: string | null;
}) {
  const [queued, setQueued] = useState(false);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const busy = running || queued || pending;
  const disabled = busy || !!disabledReason;
  const title = disabledReason ?? (running ? "A scan of this image is already running; the result appears here when it finishes." : queued ? "Scan queued." : undefined);

  function click() {
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("digest", digest);
    start(async () => {
      const res = await requestRescan(data);
      if (res.queued) {
        setQueued(true);
        toast({ title: "Scan queued", description: res.message });
      } else {
        toast({ title: "Not queued", description: res.message, tone: "error" });
      }
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="secondary" size="sm" disabled={disabled} title={title} onClick={click}>
      <RotateCw className={`size-3.5${busy ? " animate-spin" : ""}`} />
      {running || queued ? "Scanning…" : pending ? "Queuing…" : "Re-scan"}
    </Button>
  );
}
