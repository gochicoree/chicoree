"use client";

import { useActionState } from "react";
import { saveNotificationPreferences, type NotificationPrefsResult } from "@/app/actions/notifications";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useActionToast } from "@/components/ui/toast";

export interface NotificationItem {
  event: string;
  label: string;
  description: string;
  scope: "organization" | "instance" | "account";
  email: boolean;
}

export function NotificationsForm({ items, email }: { items: NotificationItem[]; email: string }) {
  const [state, action, pending] = useActionState<NotificationPrefsResult | null, FormData>(
    saveNotificationPreferences,
    null,
  );
  useActionToast(state, "Notification preferences saved");
  const orgItems = items.filter((i) => i.scope === "organization");
  const adminItems = items.filter((i) => i.scope === "instance");
  const accountItems = items.filter((i) => i.scope === "account");

  const row = (i: NotificationItem) => (
    <label key={i.event} className="flex items-start gap-3 px-4 py-3 sm:px-5">
      <input type="checkbox" name={`email:${i.event}`} defaultChecked={i.email} className="mt-0.5 size-4 accent-[var(--action)]" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {i.label}
          <Badge title={i.event}>{i.event}</Badge>
        </span>
        <span className="mt-0.5 block text-xs text-ink-2">{i.description}</span>
      </span>
    </label>
  );

  return (
    <form action={action}>
      <Card>
        <CardHeader
          eyebrow="Email"
          title="Notifications"
          description={`Sent to ${email} for the organizations you own or administer. Webhooks are configured per repository or organization and are not affected by these switches.`}
        />
        <div className="divide-y divide-line">{orgItems.map(row)}</div>
        {accountItems.length > 0 && (
          <>
            <div className="border-t border-line px-4 pb-1 pt-3 sm:px-5">
              <div className="eyebrow">Your account</div>
            </div>
            <div className="divide-y divide-line">{accountItems.map(row)}</div>
          </>
        )}
        {adminItems.length > 0 && (
          <>
            <div className="border-t border-line px-4 pb-1 pt-3 sm:px-5">
              <div className="eyebrow">Instance administration</div>
            </div>
            <div className="divide-y divide-line">{adminItems.map(row)}</div>
          </>
        )}
        <CardBody className="flex flex-wrap items-center gap-3 border-t border-line">
          <Button type="submit" disabled={pending}>
            Save preferences
          </Button>
          {state?.error && <span className="text-sm text-danger">{state.error}</span>}
        </CardBody>
      </Card>
    </form>
  );
}
