// Notification events and their per-user defaults — importable from client
// components (the Settings → Notifications tab) as well as lib/notify.ts.

export type NotificationEvent =
  | "scan.blocked"
  | "signature.blocked"
  | "scan.completed"
  | "mirror.failed"
  | "webhook.failed"
  | "quota.warning"
  | "quota.exceeded"
  | "quota.pruned"
  | "job.failed"
  | "token.expiring";

export interface NotificationEventInfo {
  event: NotificationEvent;
  label: string;
  description: string;
  /** Who receives it: owners and admins of the organization, instance administrators, or the account itself. */
  scope: "organization" | "instance" | "account";
  /** Email on unless the user switched it off. */
  defaultEmail: boolean;
}

export const NOTIFICATION_EVENTS: NotificationEventInfo[] = [
  {
    event: "scan.blocked",
    label: "Pull blocked by scan",
    description: "A scan found vulnerabilities that block an image from being pulled.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "signature.blocked",
    label: "Pull blocked by signature policy",
    description: "An image is blocked because it has no trusted signature.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "scan.completed",
    label: "Scan completed",
    description: "Every finished scan with its summary. Noisy.",
    scope: "organization",
    defaultEmail: false,
  },
  {
    event: "mirror.failed",
    label: "Mirror failed",
    description: "A mirror sync could not reach its source or imported nothing.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "webhook.failed",
    label: "Webhook failed",
    description: "A webhook delivery failed after its final retry.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "quota.warning",
    label: "Quota warning",
    description: "Storage or repository usage reached 80 % or 95 % of a limit.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "quota.exceeded",
    label: "Storage limit exceeded",
    description: "Storage is above the limit; the oldest images are removed once the grace period ends unless space is freed.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "quota.pruned",
    label: "Images removed to fit the storage limit",
    description: "What the registry removed after the grace period ran out.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "job.failed",
    label: "Job failed",
    description: "A maintenance job failed. Administrators only.",
    scope: "instance",
    defaultEmail: true,
  },
  {
    event: "token.expiring",
    label: "Credential expiring",
    description:
      "One of your access tokens, or a service account you manage, expires within seven days.",
    scope: "account",
    defaultEmail: true,
  },
];

export const NOTIFICATION_EVENT_NAMES = NOTIFICATION_EVENTS.map((e) => e.event);

export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENT_NAMES as string[]).includes(value);
}

export function defaultEmailFor(event: NotificationEvent): boolean {
  return NOTIFICATION_EVENTS.find((e) => e.event === event)?.defaultEmail ?? true;
}
