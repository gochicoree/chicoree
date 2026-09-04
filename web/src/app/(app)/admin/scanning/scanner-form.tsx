"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw, Save } from "lucide-react";
import { resetScannerSettings, saveScannerSettings, testScannerSettings, type ScannerActionResult } from "@/app/actions/scanning";
import type { SettingsSource } from "@/lib/instance-settings";
import { SCANNER_LABELS, type ScannerBackend, type ScannerSettings } from "@/lib/scanner-shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

function useResultToast(state: ScannerActionResult | null) {
  const { toast } = useToast();
  const last = useRef(state);
  useEffect(() => {
    if (state === last.current) return;
    last.current = state;
    if (state?.message && !state.error) toast({ title: state.message, tone: "success" });
    if (state?.error) toast({ title: state.error, tone: "error" });
  }, [state, toast]);
}

function SourceBadge({ source }: { source: SettingsSource }) {
  if (source === "database") return <Badge tone="ok">saved in admin settings</Badge>;
  if (source === "environment") return <Badge tone="info">from environment</Badge>;
  return <Badge>scanning off</Badge>;
}

function ResetButton() {
  const [state, action, pending] = useActionState<ScannerActionResult | null, FormData>(resetScannerSettings, null);
  useResultToast(state);
  return (
    <form action={action}>
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <RotateCcw className="size-3.5" /> Use environment values
      </Button>
    </form>
  );
}

const BACKEND_OPTIONS: { value: ScannerBackend; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Pushed images are not scanned; vulnerability columns disappear" },
  { value: "clair", label: "Clair", description: "Separate Clair v4 service (indexer + matcher) reached over HTTP" },
  { value: "trivy", label: "Trivy", description: "The trivy binary in this container, standalone or against a Trivy server" },
];

const STATUS_TONE = { ok: "ok", warn: "accent", error: "danger" } as const;

export function ScannerForm({ values, source }: { values: ScannerSettings; source: SettingsSource }) {
  const [saveState, save, saving] = useActionState<ScannerActionResult | null, FormData>(saveScannerSettings, null);
  const [testState, test, testing] = useActionState<ScannerActionResult | null, FormData>(testScannerSettings, null);
  useResultToast(saveState);
  useResultToast(testState);
  const [backend, setBackend] = useState<string>(values.backend);
  const health = testState?.health ?? null;

  return (
    <Card>
      <CardHeader
        eyebrow="Scanner"
        title="Backend"
        description="Which scanner analyses pushed images. Changing it applies to new scans; existing results keep the label of the scanner that produced them."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source={source} />
            {source === "database" && <ResetButton />}
          </div>
        }
      />
      <CardBody>
        <form action={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scanner" htmlFor="scanner-backend" hint="SCANNER in the environment is the default (clair when CLAIR_URL is set).">
              <Select id="scanner-backend" name="backend" value={backend} onChange={setBackend} options={BACKEND_OPTIONS} />
            </Field>
            {backend === "clair" && (
              <Field label="Clair URL" htmlFor="scanner-clair-url" hint="The API port of Clair in combo mode (CLAIR_URL).">
                <Input id="scanner-clair-url" name="clairUrl" defaultValue={values.clairUrl} placeholder="http://clair:6060" className="font-mono" autoComplete="off" />
              </Field>
            )}
            {backend === "trivy" && (
              <>
                <Field label="Trivy server URL" htmlFor="scanner-trivy-url" hint="Optional (TRIVY_SERVER_URL). Empty: trivy downloads its own vulnerability database into the cache volume.">
                  <Input id="scanner-trivy-url" name="trivyServerUrl" defaultValue={values.trivyServerUrl} placeholder="http://trivy:4954" className="font-mono" autoComplete="off" />
                </Field>
                <Field label="Timeout (seconds)" htmlFor="scanner-trivy-timeout" hint="Per image; the first scan also downloads the database.">
                  <Input id="scanner-trivy-timeout" name="trivyTimeoutSeconds" type="number" min={30} max={7200} defaultValue={values.trivyTimeoutSeconds} className="font-mono" />
                </Field>
              </>
            )}
            {backend !== "clair" && <input type="hidden" name="clairUrl" value={values.clairUrl} />}
            {backend !== "trivy" && (
              <>
                <input type="hidden" name="trivyServerUrl" value={values.trivyServerUrl} />
                <input type="hidden" name="trivyTimeoutSeconds" value={values.trivyTimeoutSeconds} />
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || testing}>
              <Save className="size-4" /> Save
            </Button>
            {backend !== "off" && (
              <Button type="submit" variant="secondary" formAction={test} disabled={saving || testing}>
                <FlaskConical className="size-4" /> {testing ? "Testing…" : "Test"}
              </Button>
            )}
            {saveState?.error && <span className="text-sm text-danger">{saveState.error}</span>}
          </div>
        </form>

        {(health || testState?.error) && (
          <div className="mt-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm" data-scanner-test={health?.status ?? "error"}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={health ? STATUS_TONE[health.status] : "danger"}>{health ? health.status : "error"}</Badge>
              <span className="text-ink">{health ? health.summary : testState?.error}</span>
              {health && <span className="font-mono text-xs text-ink-3">· {health.latencyMs} ms</span>}
            </div>
            {health && health.details.length > 0 && (
              <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]">
                {health.details.map((d) => (
                  <div key={d.label} className="contents">
                    <dt className="truncate text-ink-3">{d.label}</dt>
                    <dd className="min-w-0 break-all font-mono text-xs leading-relaxed text-ink">{d.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        <p className="mt-4 text-xs text-ink-3">
          {SCANNER_LABELS.clair}: start the compose <span className="font-mono">clair</span> profile. {SCANNER_LABELS.trivy}: the web image ships the
          binary; the compose <span className="font-mono">trivy</span> profile adds a server that keeps the database updated for every replica.
        </p>
      </CardBody>
    </Card>
  );
}
