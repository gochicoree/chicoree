"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { enableProxyForNewOrg } from "@/app/actions/proxy";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { PROXY_PRESETS, type ProxyPreset } from "@/lib/proxy-shared";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export default function NewOrganizationPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [proxy, setProxy] = useState(false);
  const [preset, setPreset] = useState<ProxyPreset>("dockerhub");
  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const presetDef = PROXY_PRESETS.find((p) => p.value === preset);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.organization.create({ name, slug });
    if (res.error || !res.data) {
      setBusy(false);
      setError(res.error?.message ?? "Could not create the organization");
      return;
    }
    if (proxy) {
      const fd = new FormData();
      fd.set("organizationId", res.data.id);
      fd.set("preset", preset);
      fd.set("upstreamUrl", upstreamUrl);
      const enabled = await enableProxyForNewOrg(fd);
      setBusy(false);
      if (enabled.error) {
        setError(`The organization was created, but the proxy could not be enabled: ${enabled.error}`);
        return;
      }
      router.push(`/${slug}/settings/proxy`);
      router.refresh();
      return;
    }
    setBusy(false);
    router.push(`/${slug}`);
    router.refresh();
  }

  return (
    <div>
      <PageHeader
        eyebrow="Organizations"
        title="Create an organization"
        description="An organization is a namespace for images: registry/<slug>/<repository>."
      />
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name" htmlFor="name">
              <Input
                id="name"
                required
                value={name}
                placeholder="Acme Robotics"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </Field>
            <Field
              label="Slug"
              htmlFor="slug"
              hint={`Images will live under ${slug || "<slug>"}/<repository>. Lowercase letters, digits, ._- separators.`}
            >
              <Input
                id="slug"
                required
                value={slug}
                className="font-mono"
                pattern="[a-z0-9]+([._\\-][a-z0-9]+)*"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
              />
            </Field>

            <div className="rounded-xl border border-line bg-card-2 p-3.5">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={proxy}
                  onChange={(e) => setProxy(e.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--action)]"
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    <Globe className="size-3.5 text-accent" /> Make this a proxy cache
                  </span>
                  <span className="block text-xs text-ink-2">
                    Images are fetched from an upstream registry on first pull and served from here afterwards. New
                    repositories are public so anyone can pull, and nobody can push into the organization.
                  </span>
                </span>
              </label>
              {proxy && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Upstream" htmlFor="proxy-preset" hint={presetDef?.hint}>
                    <Select
                      id="proxy-preset"
                      value={preset}
                      onChange={(v) => setPreset(v as ProxyPreset)}
                      options={PROXY_PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.url || "https://…" }))}
                    />
                  </Field>
                  {preset === "custom" && (
                    <Field label="Registry API URL" htmlFor="proxy-url">
                      <Input
                        id="proxy-url"
                        required
                        value={upstreamUrl}
                        className="font-mono"
                        placeholder="https://registry.example.com"
                        onChange={(e) => setUpstreamUrl(e.target.value)}
                      />
                    </Field>
                  )}
                  <p className="text-xs text-ink-2 sm:col-span-2">
                    Example: <code className="font-mono">docker pull &lt;registry&gt;/{slug || "<slug>"}/{preset === "dockerhub" ? "nginx:1.27" : "<namespace>/<image>:<tag>"}</code>. Credentials and
                    an allow-list can be added under Settings → Proxy.
                  </p>
                </div>
              )}
            </div>

            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy}>
              {proxy ? "Create proxy cache" : "Create organization"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
