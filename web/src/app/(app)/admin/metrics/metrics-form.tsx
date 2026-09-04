"use client";

import { useActionState, useEffect, useRef } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { saveMetricsSettings, type SettingsResult } from "@/app/actions/instance-settings";
import type { SettingsSource } from "@/lib/instance-settings";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { useToast } from "@/components/ui/toast";

export function MetricsForm({
  enabled,
  token,
  scrapeUrl,
  registryTarget,
  source,
}: {
  enabled: boolean;
  token: string;
  scrapeUrl: string;
  /** host:port of registryd as Prometheus reaches it (its /metrics takes the same token). */
  registryTarget: string;
  source: SettingsSource;
}) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(saveMetricsSettings, null);
  const { toast } = useToast();
  const last = useRef(state);
  const regenerate = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message });
  }, [state, toast]);

  const scrapeConfig = [
    "scrape_configs:",
    "  - job_name: chicoree",
    `    scheme: ${scrapeUrl.startsWith("https") ? "https" : "http"}`,
    "    metrics_path: /api/metrics",
    `    static_configs: [{ targets: ["${scrapeUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}"] }]`,
    "    authorization:",
    `      credentials: ${token || "<scrape token>"}`,
    "  - job_name: chicoree-registryd",
    "    metrics_path: /metrics",
    `    static_configs: [{ targets: ["${registryTarget}"] }]`,
    "    authorization:",
    `      credentials: ${token || "<scrape token>"}`,
  ].join("\n");

  return (
    <Card>
      <CardHeader
        eyebrow="Monitoring"
        title="Prometheus endpoint"
        description="Exposes the numbers on this page, plus per-repository pulls and storage, in the Prometheus text format; the registry itself serves request, transfer and runtime metrics at /metrics behind the same token. Scrapes must send the bearer token."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
            {source === "environment" && <Badge tone="info">from environment</Badge>}
          </div>
        }
      />
      <CardBody>
        <form action={action} className="space-y-4">
          <input ref={regenerate} type="hidden" name="regenerate" value="0" />
          <label className="flex items-start gap-2 text-sm text-ink-2">
            <input type="checkbox" name="enabled" defaultChecked={enabled} className="mt-0.5 size-4 accent-[var(--action)]" />
            <span>
              Serve metrics at <span className="font-mono text-[13px]">/api/metrics</span>
              <span className="block text-xs text-ink-3">A scrape token is generated the first time this is enabled.</span>
            </span>
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Scrape URL</div>
              <CommandLine command={scrapeUrl} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Bearer token</div>
              {token ? (
                <CommandLine command={token} />
              ) : (
                <p className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-ink-3">
                  None yet. Enable the endpoint or generate one below.
                </p>
              )}
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-3">prometheus.yml</div>
            <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink-2">
              {scrapeConfig}
            </pre>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={pending}
              onClick={() => {
                if (regenerate.current) regenerate.current.value = "0";
              }}
            >
              <Activity className="size-4" /> Save
            </Button>
            <Button
              type="submit"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                if (regenerate.current) regenerate.current.value = "1";
              }}
            >
              <RefreshCw className="size-4" /> {token ? "Regenerate token" : "Generate token"}
            </Button>
            {state?.error && <span className="text-sm text-danger">{state.error}</span>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
