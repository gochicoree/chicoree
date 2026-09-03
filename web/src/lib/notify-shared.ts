// Notification events and their per-user defaults — importable from client
// components (the Settings → Notifications tab) as well as lib/notify.ts.

export type NotificationEvent =
  | "scan.blocked"
  | "scan.completed"
  | "mirror.failed"
  | "webhook.failed"
  | "quota.warning"
  | "job.failed";

export interface NotificationEventInfo {
  event: NotificationEvent;
  label: string;
  description: string;
  /** Who receives it: owners and admins of the organization, or instance administrators. */
  scope: "organization" | "instance";
  /** Email on unless the user switched it off. */
  defaultEmail: boolean;
}

export const NOTIFICATION_EVENTS: NotificationEventInfo[] = [
  {
    event: "scan.blocked",
    label: "Pull blocked by scan",
    description: "A vulnerability scan pushed an image over the organization's pull policy threshold.",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "scan.completed",
    label: "Scan completed",
    description: "Every finished vulnerability scan, with its severity summary. Noisy — off by default.",
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
    description: "Storage or repository usage reached 80 % or 95 % of a limit (once per threshold and day).",
    scope: "organization",
    defaultEmail: true,
  },
  {
    event: "job.failed",
    label: "Job failed",
    description: "A maintenance job failed, whether run manually, from the API or on schedule. Administrators only.",
    scope: "instance",
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
