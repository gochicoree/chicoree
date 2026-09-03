"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Re-runs every check by re-rendering the (dynamic) page. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} /> {pending ? "Checking…" : "Refresh"}
    </Button>
  );
}
