"use client";

import { useActionState, useState } from "react";
import { Plus, Send, Trash2, Webhook } from "lucide-react";
import { deleteWebhook, saveWebhook, testWebhook, toggleWebhook, type WebhookResult } from "@/app/actions/webhooks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { relativeTime } from "@/lib/format";

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  authType: string;
  authHeaderName: string | null;
  hasAuthSecret: boolean;
  hasSigningSecret: boolean;
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  deliveries: { id: string; event: string; ok: boolean; statusCode: number | null; attempts: number; durationMs: number | null; error: string | null; createdAt: string }[];
}

const METHODS = [
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
];
const AUTH_TYPES = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token", description: "Authorization: Bearer <token>" },
  { value: "basic", label: "Basic auth", description: "user:password" },
  { value: "header", label: "Custom header", description: "Any header name + value" },
];

function WebhookForm({
  repositoryId,
  hook,
  onDone,
}: {
  repositoryId: string;
  hook?: WebhookRow;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<WebhookResult | null, FormData>(saveWebhook, null);
  const [authType, setAuthType] = useState(hook?.authType ?? "none");
  if (state?.saved) {
    onDone();
  }
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="repositoryId" value={repositoryId} />
      {hook && <input type="hidden" name="id" value={hook.id} />}
      <Field label="Name" htmlFor="wh-name">
        <Input id="wh-name" name="name" required defaultValue={hook?.name} placeholder="Deploy to staging" />
      </Field>
      <Field label="Method" htmlFor="wh-method">
        <Select id="wh-method" name="method" options={METHODS} defaultValue={hook?.method ?? "POST"} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="URL" htmlFor="wh-url">
          <Input id="wh-url" name="url" type="url" required defaultValue={hook?.url} className="font-mono" placeholder="https://ci.example.com/hooks/registry" />
        </Field>
      </div>
      <Field label="Authentication" htmlFor="wh-auth">
        <Select id="wh-auth" name="authType" options={AUTH_TYPES} value={authType} onChange={setAuthType} />
      </Field>
      {authType === "header" && (
        <Field label="Header name" htmlFor="wh-auth-header">
          <Input id="wh-auth-header" name="authHeaderName" defaultValue={hook?.authHeaderName ?? ""} className="font-mono" placeholder="X-Api-Key" />
        </Field>
      )}
      {authType !== "none" && (
        <div className={authType === "header" ? "sm:col-span-2" : ""}>
          <Field
            label={authType === "basic" ? "user:password" : authType === "bearer" ? "Token" : "Header value"}
            htmlFor="wh-secret"
            hint={hook?.hasAuthSecret ? "Stored encrypted — leave blank to keep, enter - to clear" : "Stored encrypted"}
          >
            <Input id="wh-secret" name="authSecret" type="password" autoComplete="new-password" className="font-mono" />
          </Field>
        </div>
      )}
      <div className="sm:col-span-2">
        <Field label="Extra headers" htmlFor="wh-headers" hint="One per line: Name: value">
          <Textarea
            id="wh-headers"
            name="headers"
            className="font-mono text-xs"
            defaultValue={hook ? Object.entries(hook.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : ""}
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field
          label="Signing secret"
          htmlFor="wh-signing"
          hint={`Adds X-Chicoree-Signature: sha256=<hmac of the body>.${hook?.hasSigningSecret ? " Stored — leave blank to keep, enter - to clear." : ""}`}
        >
          <Input id="wh-signing" name="signingSecret" type="password" autoComplete="new-password" className="font-mono" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="events" value="push" defaultChecked className="size-4 accent-[var(--action)]" />
        Send on image push
      </label>
      {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">{state.error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {hook ? "Save webhook" : "Add webhook"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TestButton({ repositoryId, hookId }: { repositoryId: string; hookId: string }) {
  const [state, action, pending] = useActionState<WebhookResult | null, FormData>(testWebhook, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="id" value={hookId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <Send className="size-3.5" /> {pending ? "Sending…" : "Send test"}
      </Button>
      {state?.tested && (
        <span className={`text-xs ${state.tested.ok ? "text-ok" : "text-danger"}`}>
          {state.tested.ok ? `delivered (${state.tested.status})` : (state.tested.error ?? "failed")}
        </span>
      )}
    </form>
  );
}

export function WebhooksManager({
  repositoryId,
  hooks,
  max,
}: {
  repositoryId: string;
  hooks: WebhookRow[];
  max: number;
}) {
  const [editing, setEditing] = useState<WebhookRow | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader
        eyebrow="Notifications"
        title={`Webhooks (${hooks.length}/${max})`}
        description="Called whenever an image is pushed to this repository, with everything about the image, tag and pusher in a JSON body."
        action={
          <Button size="sm" variant="secondary" disabled={hooks.length >= max} onClick={() => setEditing("new")}>
            <Plus className="size-3.5" /> Add webhook
          </Button>
        }
      />
      {hooks.length === 0 ? (
        <CardBody>
          <p className="text-sm text-ink-3">No webhooks yet.</p>
        </CardBody>
      ) : (
        <div>
          {hooks.map((h) => (
            <div key={h.id} className="border-b border-line px-4 py-3 last:border-0 sm:px-5">
              <div className="flex flex-wrap items-center gap-3">
                <Webhook className="size-4 shrink-0 text-ink-3" />
                <button onClick={() => setEditing(h)} className="text-sm font-medium hover:underline cursor-pointer">
                  {h.name}
                </button>
                <span className="min-w-0 max-w-full break-all font-mono text-xs text-ink-2">
                  {h.method} {h.url}
                </span>
                {!h.enabled && <Badge>paused</Badge>}
                {h.lastStatus !== null && (
                  <Badge tone={h.lastStatus >= 200 && h.lastStatus < 300 ? "ok" : "danger"}>
                    {h.lastStatus} · {relativeTime(h.lastDeliveredAt)}
                  </Badge>
                )}
                {h.lastStatus === null && h.lastError && <Badge tone="danger">{h.lastError}</Badge>}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <TestButton repositoryId={repositoryId} hookId={h.id} />
                  <form action={toggleWebhook}>
                    <input type="hidden" name="repositoryId" value={repositoryId} />
                    <input type="hidden" name="id" value={h.id} />
                    <input type="hidden" name="enabled" value={String(!h.enabled)} />
                    <Button type="submit" variant="ghost" size="sm">
                      {h.enabled ? "Pause" : "Resume"}
                    </Button>
                  </form>
                  <button
                    onClick={() => setExpanded(expanded === h.id ? null : h.id)}
                    className="text-[13px] text-ink-2 hover:text-ink cursor-pointer"
                  >
                    {expanded === h.id ? "Hide log" : "Log"}
                  </button>
                  <form action={deleteWebhook}>
                    <input type="hidden" name="repositoryId" value={repositoryId} />
                    <input type="hidden" name="id" value={h.id} />
                    <button
                      type="submit"
                      aria-label={`Delete ${h.name}`}
                      className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </form>
                </div>
              </div>
              {expanded === h.id && (
                <div className="mt-3 rounded-lg border border-line bg-card-2">
                  {h.deliveries.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-ink-3">No deliveries yet.</p>
                  ) : (
                    h.deliveries.map((d) => (
                      <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-3 py-1.5 font-mono text-xs last:border-0">
                        <span className={d.ok ? "text-ok" : "text-danger"}>{d.statusCode ?? "—"}</span>
                        <span>{d.event}</span>
                        <span className="text-ink-3">{d.attempts} attempt{d.attempts === 1 ? "" : "s"} · {d.durationMs ?? "?"} ms</span>
                        {d.error && <span className="min-w-0 basis-full truncate text-danger sm:basis-auto sm:flex-1">{d.error}</span>}
                        <span className="ml-auto text-ink-3">{relativeTime(d.createdAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add webhook" : "Edit webhook"}
        description="Secrets are encrypted at rest and never shown again."
      >
        {editing !== null && (
          <WebhookForm repositoryId={repositoryId} hook={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />
        )}
      </Modal>
    </Card>
  );
}
