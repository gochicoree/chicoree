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
  | "quota.warning";

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
];

export const WEBHOOK_EVENT_NAMES = WEBHOOK_EVENTS.map((e) => e.value);

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENT_NAMES as string[]).includes(value);
}

/** Events a hook of this scope may subscribe to. */
export function eventsForScope(scope: "repository" | "organization"): WebhookEventInfo[] {
  return WEBHOOK_EVENTS.filter((e) => scope === "organization" || !e.organizationOnly);
}

export const MAX_WEBHOOKS_PER_REPO = 5;
export const MAX_WEBHOOKS_PER_ORG = 10;

/** What the hook list and its delivery log render. */
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
