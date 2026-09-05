"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { portalHandoffUrl } from "@/lib/quota-shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/**
 * Opens the account portal (Administration → Limits) with a short-lived
 * one-time token so the portal knows who arrived; `organization` tells it
 * which organization's settings the user came from.
 */
export function PortalButton({ url, label, organization }: { url: string; label: string; organization?: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    const res = await authClient.oneTimeToken.generate();
    const token = res.data?.token;
    if (res.error || !token) {
      setBusy(false);
      toast({ title: "Could not open the portal", description: res.error?.message ?? "Try again in a moment." });
      return;
    }
    window.location.assign(portalHandoffUrl(url, token, organization));
  }

  return (
    <Button type="button" onClick={go} disabled={busy} variant="secondary" size="sm">
      <ExternalLink className="size-3.5" /> {label || "Manage"}
    </Button>
  );
}
