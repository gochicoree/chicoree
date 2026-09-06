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
export type WebhookFormat = "json" | "slack" | "discord" | "teams" | "text";

export const WEBHOOK_FORMATS: { value: WebhookFormat; label: string; description: string }[] = [
  { value: "json", label: "JSON payload", description: "The full event for your own receiver" },
  { value: "slack", label: "Slack", description: "Incoming webhook message (Block Kit)" },
  { value: "discord", label: "Discord", description: "Webhook message with an embed" },
  { value: "teams", label: "Microsoft Teams", description: "Adaptive Card for a Workflows webhook" },
  { value: "text", label: "Plain text", description: "{ \"text\": … } for Mattermost, Google Chat, Rocket.Chat" },
];

export function isWebhookFormat(value: string): value is WebhookFormat {
  return WEBHOOK_FORMATS.some((f) => f.value === value);
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
