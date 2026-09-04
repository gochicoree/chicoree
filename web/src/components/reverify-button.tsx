"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { reverifyManifestAction } from "@/app/actions/trusted-keys";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Re-check every signature and attestation of an image against the trusted keys. */
export function ReverifyButton({ repositoryId, digest }: { repositoryId: string; digest: string }) {
  const [busy, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  function run() {
    const data = new FormData();
    data.set("repositoryId", repositoryId);
    data.set("digest", digest);
    start(async () => {
      const res = await reverifyManifestAction(data);
      if (res.error) toast({ title: "Re-verify failed", description: res.error, tone: "error" });
      else toast({ title: "Signatures re-verified", description: `${res.signed ?? 0} signed artifact${res.signed === 1 ? "" : "s"} checked.` });
      router.refresh();
    });
  }
  return (
    <Button type="button" variant="secondary" size="sm" onClick={run} disabled={busy}>
      <RotateCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Verifying…" : "Re-verify"}
    </Button>
  );
}
