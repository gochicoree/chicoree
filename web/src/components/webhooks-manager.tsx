"use client";

import { useActionState, useEffect, useState } from "react";
import { Plus, Send, Trash2, Webhook } from "lucide-react";
import { deleteWebhook, saveWebhook, testWebhook, toggleWebhook, type WebhookResult } from "@/app/actions/webhooks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, pageSlice } from "@/lib/paginate-shared";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import { eventsForScope, formatAllowsMethod, WEBHOOK_EVENTS, WEBHOOK_FORMATS, WEBHOOK_PLACEHOLDERS, type WebhookFormat, type WebhookRow, type WebhookScope } from "@/lib/webhooks-shared";

export type { WebhookRow };

const METHODS = [
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "GET", label: "GET", description: "No body; for endpoints that act on the request itself, e.g. a deploy hook" },
  { value: "PATCH", label: "PATCH" },
];
const AUTH_TYPES = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token", description: "Authorization: Bearer <token>" },
  { value: "basic", label: "Basic auth", description: "user:password" },
  { value: "header", label: "Custom header", description: "Any header name + value" },
];

function eventLabel(value: string): string {
  return WEBHOOK_EVENTS.find((e) => e.value === value)?.label ?? value;
}

function formatLabel(value: string): string {
  return WEBHOOK_FORMATS.find((f) => f.value === value)?.label ?? value;
}

function ScopeInputs({ scope }: { scope: WebhookScope }) {
  return scope.kind === "repository" ? (
    <input type="hidden" name="repositoryId" value={scope.repositoryId} />
  ) : (
    <input type="hidden" name="organizationId" value={scope.organizationId} />
  );
}

function WebhookForm({ scope, hook, onDone }: { scope: WebhookScope; hook?: WebhookRow; onDone: () => void }) {
  const [state, action, pending] = useActionState<WebhookResult | null, FormData>(saveWebhook, null);
  const [authType, setAuthType] = useState(hook?.authType ?? "none");
  const [format, setFormat] = useState<string>(hook?.format ?? "json");
  const chat = !formatAllowsMethod(format);
  const { toast } = useToast();
  const events = eventsForScope(scope.kind);
  const selected = new Set(hook?.events ?? ["push"]);
  useEffect(() => {
    if (state?.saved) {
      toast({ title: hook ? "Webhook saved" : "Webhook added" });
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <ScopeInputs scope={scope} />
      {hook && <input type="hidden" name="id" value={hook.id} />}
      <Field label="Name" htmlFor="wh-name">
        <Input id="wh-name" name="name" required defaultValue={hook?.name} placeholder="Deploy to staging" />
      </Field>
      <Field label="Format" htmlFor="wh-format" hint={chat ? "Sent as a POST the service understands" : format === "none" ? "Nothing but the request: right for deploy hooks whose parameters sit in the URL" : undefined}>
        <Select id="wh-format" name="format" options={WEBHOOK_FORMATS} value={format} onChange={(v) => setFormat(v as WebhookFormat)} />
      </Field>
      {!chat && (
        <Field label="Method" htmlFor="wh-method">
          <Select id="wh-method" name="method" options={METHODS} defaultValue={hook?.method ?? "POST"} />
        </Field>
      )}
      {format === "custom" && (
        <div className="sm:col-span-2 lg:col-span-4">
          <Field
            label="Payload (JSON)"
            htmlFor="wh-payload"
            hint={`Placeholders: ${WEBHOOK_PLACEHOLDERS.filter((p) => p.key !== "event.<path>").map((p) => `{{${p.key}}}`).join(" ")} and {{event.<path>}} for any field. A value that is exactly "{{event}}" embeds the whole event as JSON.`}
          >
            <Textarea
              id="wh-payload"
              name="payloadTemplate"
              required
              rows={5}
              defaultValue={hook?.payloadTemplate ?? '{\n  "uuid": "…",\n  "force": false,\n  "event": "{{event}}"\n}'}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </div>
      )}
      <div className="sm:col-span-2">
        <Field label="URL" htmlFor="wh-url" hint={chat ? "The incoming-webhook URL the chat service gave you" : undefined}>
          <Input
            id="wh-url"
            name="url"
            type="url"
            required
            defaultValue={hook?.url}
            className="font-mono"
            placeholder={
              format === "slack"
                ? "https://hooks.slack.com/services/…"
                : format === "discord"
                  ? "https://discord.com/api/webhooks/…"
                  : format === "teams"
                    ? "https://….logic.azure.com/workflows/…"
                    : "https://ci.example.com/hooks/registry"
            }
          />
        </Field>
      </div>
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="mb-1.5 block text-[13px] font-medium text-ink">Events</legend>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          {events.map((e) => (
            <label key={e.value} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-sm">
              <input
                type="checkbox"
                name="events"
                value={e.value}
                defaultChecked={selected.has(e.value)}
                className="mt-0.5 size-4 accent-[var(--action)]"
              />
              <span className="min-w-0">
                <span className="block font-medium">{e.label}</span>
                <span className="block text-xs text-ink-2">{e.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Authentication" htmlFor="wh-auth">
        <Select id="wh-auth" name="authType" options={AUTH_TYPES} value={authType} onChange={setAuthType} />
      </Field>
      {authType === "header" && (
        <Field label="Header name" htmlFor="wh-auth-header">
          <Input id="wh-auth-header" name="authHeaderName" defaultValue={hook?.authHeaderName ?? ""} className="font-mono" placeholder="X-Api-Key" />
        </Field>
      )}
      {authType !== "none" && (
        <div className={authType === "header" ? "sm:col-span-2" : "sm:col-span-2 lg:col-span-3"}>
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
            rows={3}
            className="min-h-0 font-mono text-xs"
            defaultValue={hook ? Object.entries(hook.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : ""}
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field
          label="Signing secret"
          htmlFor="wh-signing"
          hint={`Signs each delivery in the X-Chicoree-Signature header.${hook?.hasSigningSecret ? " Stored — leave blank to keep, enter - to clear." : ""}`}
        >
          <Input id="wh-signing" name="signingSecret" type="password" autoComplete="new-password" className="font-mono" />
        </Field>
      </div>
      {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2 lg:col-span-4">{state.error}</p>}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
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

/**
 * The delivery log of one hook. The log is capped at WEBHOOK_LOG_MAX rows per
 * hook in the database, arrives with the hook and is paged here — the log is
 * opened and closed in the browser, so its page belongs to the component.
 */
function DeliveryLog({ hook }: { hook: WebhookRow }) {
  const [page, setPage] = useState(1);
  const { rows, state } = pageSlice(hook.deliveries, page, PAGE_SIZES.webhookDeliveries);
  return (
    <div className="mt-3 rounded-lg border border-line bg-card-2" data-webhook-log={hook.id}>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-ink-3">No deliveries yet.</p>
      ) : (
        rows.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-3 py-1.5 font-mono text-xs last:border-0">
            <span className={d.ok ? "text-ok" : "text-danger"}>{d.statusCode ?? "—"}</span>
            <span>{d.event}</span>
            <span className="text-ink-3">{d.attempts} attempt{d.attempts === 1 ? "" : "s"} · {d.durationMs ?? "?"} ms</span>
            {d.error && <span className="min-w-0 basis-full truncate text-danger sm:basis-auto sm:flex-1">{d.error}</span>}
            <span className="ml-auto text-ink-3">{relativeTime(d.createdAt)}</span>
          </div>
        ))
      )}
      {state.total > 0 && (
        <div className="border-t border-line px-3 py-2">
          <Pagination state={state} noun="deliveries" onPage={setPage} label={`Delivery log pages for ${hook.name}`} always />
        </div>
      )}
    </div>
  );
}

function TestButton({ scope, hookId }: { scope: WebhookScope; hookId: string }) {
  const [state, action, pending] = useActionState<WebhookResult | null, FormData>(testWebhook, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <ScopeInputs scope={scope} />
      <input type="hidden" name="id" value={hookId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <Send className="size-3.5" /> {pending ? "Sending…" : "Send test"}
      </Button>
      {state?.tested && (
        <span className={`text-xs ${state.tested.ok ? "text-ok" : "text-danger"}`}>
          {state.tested.ok ? `delivered (${state.tested.status})` : (state.tested.error ?? "failed")}
        </span>
      )}
      {state?.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}

/**
 * Webhook list + editor, shared by the repository and the organization
 * settings. Organization hooks receive the events of every repository.
 */
export function WebhooksManager({ scope, hooks, max }: { scope: WebhookScope; hooks: WebhookRow[]; max: number }) {
  const [editing, setEditing] = useState<WebhookRow | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const org = scope.kind === "organization";

  return (
    <Card>
      <CardHeader
        eyebrow="Notifications"
        title={`Webhooks (${hooks.length}/${max})`}
        description={
          org
            ? "Called with a JSON body when something happens in any repository of this organization."
            : "Called with a JSON body when something happens in this repository."
        }
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
                {h.format !== "json" && <Badge tone="info">{formatLabel(h.format)}</Badge>}
                {!h.enabled && <Badge>paused</Badge>}
                {h.lastStatus !== null && (
                  <Badge tone={h.lastStatus >= 200 && h.lastStatus < 300 ? "ok" : "danger"}>
                    {h.lastStatus} · {relativeTime(h.lastDeliveredAt)}
                  </Badge>
                )}
                {h.lastStatus === null && h.lastError && <Badge tone="danger">{h.lastError}</Badge>}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <TestButton scope={scope} hookId={h.id} />
                  <form action={toggleWebhook}>
                    <ScopeInputs scope={scope} />
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
                    <ScopeInputs scope={scope} />
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
              <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
                {h.events.map((e) => (
                  <Badge key={e} tone="info" title={e}>
                    {eventLabel(e)}
                  </Badge>
                ))}
              </div>
              {expanded === h.id && <DeliveryLog hook={h} />}
            </div>
          ))}
        </div>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add webhook" : "Edit webhook"}
        description="Secrets are never shown again."
        size="xl"
      >
        {editing !== null && <WebhookForm scope={scope} hook={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </Card>
  );
}
