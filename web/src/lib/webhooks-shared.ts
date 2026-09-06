// Webhook event catalogue and view types shared by the server (delivery,
// actions) and the client (hook form, delivery log). No database access.

export type WebhookEvent =
  | "push"
  | "delete"
  | "scan.completed"
  | "scan.blocked"
  | "signature.blocked"
  | "mirror.completed"
  | "mirror.failed"
  | "retention.completed"
  | "repository.renamed"
  | "repository.transferred"
  | "quota.warning"
  | "quota.exceeded"
  | "quota.pruned";

export interface WebhookEventInfo {
  value: WebhookEvent;
  label: string;
  description: string;
  /** Organization-level events have no repository; they only reach organization hooks. */
  organizationOnly?: boolean;
}

export const WEBHOOK_EVENTS: WebhookEventInfo[] = [
  { value: "push", label: "Push", description: "An image or tag was pushed" },
  { value: "delete", label: "Delete", description: "A tag or manifest was deleted" },
  { value: "scan.completed", label: "Scan completed", description: "A vulnerability scan finished" },
  { value: "scan.blocked", label: "Pull blocked", description: "A scan put an image over the pull policy threshold" },
  { value: "signature.blocked", label: "Signature required", description: "The signature policy blocked an image without a trusted signature" },
  { value: "mirror.completed", label: "Mirror completed", description: "A mirror sync finished" },
  { value: "mirror.failed", label: "Mirror failed", description: "A mirror sync failed" },
  { value: "retention.completed", label: "Retention completed", description: "A retention run deleted (or would delete) tags" },
  { value: "repository.renamed", label: "Repository renamed", description: "The repository got a new name (the old one redirects)" },
  { value: "repository.transferred", label: "Repository transferred", description: "The repository moved to another organization" },
  { value: "quota.warning", label: "Quota warning", description: "Usage reached 80 % / 95 % of a limit", organizationOnly: true },
  { value: "quota.exceeded", label: "Storage limit exceeded", description: "Storage is above the limit; images are removed after the grace period", organizationOnly: true },
  { value: "quota.pruned", label: "Images removed to fit", description: "The registry removed the oldest images to meet the storage limit", organizationOnly: true },
];

export const WEBHOOK_EVENT_NAMES = WEBHOOK_EVENTS.map((e) => e.value);

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENT_NAMES as string[]).includes(value);
}

/** Events a hook of this scope may subscribe to. */
export function eventsForScope(scope: "repository" | "organization"): WebhookEventInfo[] {
  return WEBHOOK_EVENTS.filter((e) => scope === "organization" || !e.organizationOnly);
}

/**
 * Body formats. "json" is the documented payload; the others render the same
 * event as a message for a chat service's incoming webhook (lib/webhook-chat.ts).
 */
export type WebhookFormat = "json" | "none" | "custom" | "slack" | "discord" | "teams" | "text";

export const WEBHOOK_FORMATS: { value: WebhookFormat; label: string; description: string }[] = [
  { value: "json", label: "JSON payload", description: "The full event for your own receiver" },
  { value: "custom", label: "Custom JSON", description: "Your own body; {{placeholders}} fill in the event, \"{{event}}\" embeds all of it" },
  { value: "none", label: "No body", description: "Just the request with your headers and authentication — for deploy hooks that read parameters from the URL" },
  { value: "slack", label: "Slack", description: "Incoming webhook message (Block Kit)" },
  { value: "discord", label: "Discord", description: "Webhook message with an embed" },
  { value: "teams", label: "Microsoft Teams", description: "Adaptive Card for a Workflows webhook" },
  { value: "text", label: "Plain text", description: "{ \"text\": … } for Mattermost, Google Chat, Rocket.Chat" },
];

export function isWebhookFormat(value: string): value is WebhookFormat {
  return WEBHOOK_FORMATS.some((f) => f.value === value);
}

/** Formats that let the hook choose its HTTP method; chat services accept POST only. */
export function formatAllowsMethod(format: string): boolean {
  return format === "json" || format === "none" || format === "custom";
}

export const PAYLOAD_TEMPLATE_MAX = 20_000;

/**
 * Placeholders for the "custom" format. `{{event}}` as the entire string
 * value embeds the whole event as JSON; any other placeholder, or one mixed
 * into text, becomes a string. `{{event.<path>}}` reaches any field of the
 * event (`{{event.image.digest}}`); the short names are aliases for the
 * common ones.
 */
export const WEBHOOK_PLACEHOLDERS: { key: string; description: string }[] = [
  { key: "event", description: "the whole event as JSON when it is the entire value (\"{{event}}\"), its name (push, delete, …) inside text" },
  { key: "repository", description: "the image path as pulled, e.g. acme/api" },
  { key: "organization", description: "organization slug" },
  { key: "tag", description: "tag name; empty for digest-only events" },
  { key: "digest", description: "manifest digest" },
  { key: "reference", description: "full pull reference, registry/path:tag" },
  { key: "registry", description: "registry host" },
  { key: "actor", description: "who triggered the event" },
  { key: "timestamp", description: "ISO 8601 time of the event" },
  { key: "deliveryId", description: "unique per delivery" },
  { key: "event.<path>", description: "any field of the event, e.g. event.image.digest" },
];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function lookup(envelope: Record<string, unknown>, key: string): unknown {
  const e = envelope as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (key) {
    case "event":
      return e;
    case "repository":
      return e.repository?.path ?? "";
    case "organization":
      return e.organization?.slug ?? e.repository?.organization ?? "";
    case "tag":
      return e.tag ?? "";
    case "digest":
      return e.image?.digest ?? e.digest ?? "";
    case "reference":
      return e.image?.reference ?? "";
    case "registry":
      return e.registry ?? "";
    case "actor":
      return e.actor?.name ?? e.actor?.label ?? e.actor?.type ?? "";
    case "timestamp":
      return e.timestamp ?? "";
    case "deliveryId":
      return e.deliveryId ?? "";
  }
  if (key.startsWith("event.")) {
    let v: unknown = e;
    for (const part of key.slice(6).split(".")) {
      if (v === null || typeof v !== "object") return undefined;
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  }
  return undefined;
}

function asText(v: unknown, key: string): string {
  if (v === undefined || v === null) return "";
  if (key === "event" && typeof v === "object") return String((v as { event?: unknown }).event ?? "");
  return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

function renderValue(value: Json, envelope: Record<string, unknown>): Json {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(value);
    if (whole) {
      const v = lookup(envelope, whole[1]);
      if (v !== undefined && typeof v !== "string") return v as Json; // embed objects, numbers, booleans, null as they are
      return asText(v, whole[1]);
    }
    return value.replace(PLACEHOLDER, (_m, key: string) => asText(lookup(envelope, key), key));
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, envelope));
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderValue(v, envelope);
    return out;
  }
  return value;
}

/** The template with every placeholder filled from the event; throws on invalid JSON. */
export function renderPayloadTemplate(template: string, envelope: Record<string, unknown>): Json {
  return renderValue(JSON.parse(template) as Json, envelope);
}

/** Null when the template is usable, otherwise what is wrong with it. */
export function validatePayloadTemplate(template: string): string | null {
  if (!template.trim()) return "Enter the JSON body to send.";
  if (template.length > PAYLOAD_TEMPLATE_MAX) return `The payload template is limited to ${PAYLOAD_TEMPLATE_MAX} characters.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (err) {
    return `The payload template is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (parsed === null || typeof parsed !== "object") return "The payload template must be a JSON object or array.";
  for (const m of template.matchAll(PLACEHOLDER)) {
    const key = m[1];
    if (!WEBHOOK_PLACEHOLDERS.some((p) => p.key === key) && !key.startsWith("event.")) return `Unknown placeholder {{${key}}}.`;
  }
  return null;
}

export const MAX_WEBHOOKS_PER_REPO = 5;
export const MAX_WEBHOOKS_PER_ORG = 10;

/** What the hook list and its delivery log render. */
export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  method: string;
  format: WebhookFormat;
  headers: Record<string, string>;
  authType: string;
  authHeaderName: string | null;
  hasAuthSecret: boolean;
  hasSigningSecret: boolean;
  /** Body of the custom format; null otherwise. */
  payloadTemplate: string | null;
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  deliveries: {
    id: string;
    event: string;
    ok: boolean;
    statusCode: number | null;
    attempts: number;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
  }[];
}

/** Identifies the owner of a set of hooks. */
export type WebhookScope =
  | { kind: "repository"; repositoryId: string }
  | { kind: "organization"; organizationId: string };
