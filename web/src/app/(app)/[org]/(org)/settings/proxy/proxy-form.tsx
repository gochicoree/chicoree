"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Radar } from "lucide-react";
import { removeOrgProxy, saveOrgProxy, testOrgProxy, type ProxyActionResult } from "@/app/actions/proxy";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { CommandLine } from "@/components/ui/copy";
import { Badge } from "@/components/ui/badge";
import { useActionToast, useToast } from "@/components/ui/toast";
import { displayHost, isDockerHubUrl, presetFor, PROXY_PRESETS, type ProxyPreset } from "@/lib/proxy-shared";
import { relativeTime } from "@/lib/format";

export interface ProxyFormValues {
  upstreamUrl: string;
  preset: string;
  hasAuth: boolean;
  username: string;
  allowedPatterns: string;
  tagTtlSeconds: number;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export function ProxyForm({
  organizationId,
  slug,
  registryHost,
  isLibrary,
  proxy,
}: {
  organizationId: string;
  slug: string;
  registryHost: string;
  isLibrary: boolean;
  proxy: ProxyFormValues | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saveState, saveAction, saving] = useActionState<ProxyActionResult | null, FormData>(saveOrgProxy, null);
  const [testState, testAction, testing] = useActionState<ProxyActionResult | null, FormData>(testOrgProxy, null);
  useActionToast(saveState, proxy ? "Proxy settings saved" : "Proxy cache enabled");

  const [preset, setPreset] = useState<ProxyPreset>((proxy?.preset as ProxyPreset) ?? "dockerhub");
  const [upstreamUrl, setUpstreamUrl] = useState(proxy?.upstreamUrl ?? PROXY_PRESETS[0].url);
  const [enabled, setEnabled] = useState(proxy?.enabled ?? true);
  const [removing, setRemoving] = useState(false);
  const presetDef = PROXY_PRESETS.find((p) => p.value === preset);
  const dockerHub = isDockerHubUrl(upstreamUrl);
  const example = dockerHub ? "nginx:1.27" : preset === "ghcr" ? "oras-project/oras:v1.2.0" : "<namespace>/<image>:<tag>";

  function pickPreset(value: string) {
    const p = value as ProxyPreset;
    setPreset(p);
    const def = PROXY_PRESETS.find((x) => x.value === p);
    if (def?.url) setUpstreamUrl(def.url);
  }

  async function remove() {
    if (!confirm("Turn the proxy cache off and forget the upstream? Cached repositories stay as normal repositories.")) return;
    setRemoving(true);
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    const res = await removeOrgProxy(fd);
    setRemoving(false);
    if (res.error) toast({ title: res.error, tone: "error" });
    else {
      toast({ title: "Proxy cache removed" });
      router.refresh();
    }
  }

  if (isLibrary) {
    return (
      <Card>
        <CardHeader eyebrow="Proxy cache" title="Not available for the library organization" description="Top-level image names are owned by this instance; create a separate organization (for example “dockerhub”) to cache an upstream registry." />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          eyebrow="Proxy cache"
          title={proxy ? `Proxy cache of ${displayHost(proxy.upstreamUrl)}` : "Turn this organization into a proxy cache"}
          description="Images pulled through this organization are fetched from the upstream registry on first use, stored here like a push (dedup, quotas, scanning and webhooks apply) and served from the cache afterwards. Nobody can push into a proxy organization."
          action={
            proxy ? (
              <Badge tone={proxy.enabled ? "ok" : "neutral"}>{proxy.enabled ? "enabled" : "paused"}</Badge>
            ) : undefined
          }
        />
        <CardBody>
          <form action={saveAction} className="space-y-5">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="enabled" value={enabled ? "on" : "off"} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Upstream registry" htmlFor="proxy-preset" hint={presetDef?.hint}>
                <Select
                  id="proxy-preset"
                  name="preset"
                  value={preset}
                  onChange={pickPreset}
                  options={PROXY_PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.url || "https://…" }))}
                />
              </Field>
              <Field label="Registry API URL" htmlFor="proxy-url" hint="Scheme and host of the distribution API (/v2/ is appended).">
                <Input
                  id="proxy-url"
                  name="upstreamUrl"
                  value={upstreamUrl}
                  required
                  className="font-mono"
                  placeholder="https://registry.example.com"
                  onChange={(e) => {
                    setUpstreamUrl(e.target.value);
                    setPreset(presetFor(e.target.value));
                  }}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Username" htmlFor="proxy-user" hint="Optional. Docker Hub: your account name; GHCR: your GitHub login.">
                <Input id="proxy-user" name="username" defaultValue={proxy?.username ?? ""} autoComplete="off" placeholder="upstream account" />
              </Field>
              <Field
                label="Password or access token"
                htmlFor="proxy-pass"
                hint={proxy?.hasAuth ? "Credentials are configured. Leave blank to keep them." : "Stored encrypted; never shown again."}
              >
                <div className="flex items-center gap-2">
                  <Input id="proxy-pass" name="password" type="password" autoComplete="new-password" placeholder={proxy?.hasAuth ? "••••••••" : "token"} />
                  {proxy?.hasAuth && (
                    <Badge tone="ok" className="shrink-0">
                      <CheckCircle2 className="size-3" /> configured
                    </Badge>
                  )}
                </div>
              </Field>
            </div>
            {proxy?.hasAuth && (
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" name="clearAuth" className="size-4 accent-[var(--action)]" />
                Forget the stored credentials (pull anonymously)
              </label>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Allowed images"
                htmlFor="proxy-patterns"
                hint="Globs on the upstream path, separated by spaces; * also matches slashes. Empty = everything. Example: library/* bitnami/*"
              >
                <Textarea id="proxy-patterns" name="allowedPatterns" defaultValue={proxy?.allowedPatterns ?? ""} className="font-mono min-h-16" placeholder="library/* bitnami/redis" />
              </Field>
              <div className="space-y-4">
                <Field label="Tag freshness (seconds)" htmlFor="proxy-ttl" hint="How long a cached tag → digest mapping is trusted before the upstream is asked again with a HEAD request.">
                  <Input id="proxy-ttl" name="tagTtlSeconds" type="number" min={0} max={2592000} defaultValue={proxy?.tagTtlSeconds ?? 300} className="font-mono" />
                </Field>
                <label className="flex items-start gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5 size-4 accent-[var(--action)]" />
                  <span>
                    Fetch from the upstream
                    <span className="block text-xs text-ink-3">Untick to pause: cached images stay pullable, nothing new is fetched.</span>
                  </span>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving || testing}>
                {proxy ? "Save proxy settings" : "Enable proxy cache"}
              </Button>
              <Button type="submit" variant="secondary" formAction={testAction} disabled={saving || testing}>
                <Radar className="size-4" /> {testing ? "Testing…" : "Test upstream"}
              </Button>
              {saveState?.error && <span className="text-sm text-danger">{saveState.error}</span>}
              {testState?.error && <span className="text-sm text-danger">{testState.error}</span>}
            </div>
            {testState?.test && (
              <p
                className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
                  testState.test.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"
                }`}
              >
                {testState.test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
                <span>{testState.test.message}</span>
              </p>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader eyebrow="Usage" title="Pulling through the cache" description={`Prefix the upstream image path with ${slug}/. ${dockerHub ? "Docker Hub library images work with or without the library/ prefix and are stored under their short name." : ""}`} />
        <CardBody className="space-y-2">
          <CommandLine command={`docker pull ${registryHost}/${slug}/${example}`} />
          {dockerHub && <CommandLine command={`docker pull ${registryHost}/${slug}/bitnami/redis:7.4`} />}
          <p className="pt-1 text-xs text-ink-2">
            Repositories are created on first pull with this organization&apos;s default visibility (Policies tab); make it public to allow
            anonymous pulls as on the upstream. Tags nobody pulled for a while are removed by the <code className="font-mono">proxy-evict</code> job.
          </p>
        </CardBody>
      </Card>

      {proxy && (
        <Card className={proxy.lastError ? "border-danger/30" : undefined}>
          <CardHeader
            eyebrow="Status"
            title={proxy.lastError ? "Last upstream contact failed" : "Upstream status"}
            description={proxy.lastCheckedAt ? `Last contact ${relativeTime(proxy.lastCheckedAt)}.` : "The upstream has not been contacted yet."}
            action={
              <Button variant="danger" size="sm" onClick={remove} disabled={removing}>
                Remove proxy cache
              </Button>
            }
          />
          {proxy.lastError && (
            <CardBody>
              <p className="flex items-start gap-2 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span className="[overflow-wrap:anywhere]">{proxy.lastError}</span>
              </p>
            </CardBody>
          )}
        </Card>
      )}
    </div>
  );
}
