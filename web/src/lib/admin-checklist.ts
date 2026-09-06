// Administrator setup checklist for /admin: one row per thing a fresh
// instance usually still needs, each linking to the page that fixes it.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "./env";
import { scannerLabel, scanningEnabled } from "./scanners";
import { quickHealth } from "./health";
import { getInstanceSettings } from "./instance-settings";
import { listSchedules } from "./schedules";
import { DEFAULT_BRANDING } from "./branding-shared";

export type ChecklistStatus = "ok" | "warn" | "error" | "info";

export interface ChecklistRow {
  key: string;
  title: string;
  status: ChecklistStatus;
  summary: string;
  href: string;
  linkLabel: string;
  /** External link (opens in a new tab). */
  external?: boolean;
}

export interface AdminChecklist {
  rows: ChecklistRow[];
  dismissed: boolean;
  /** Rows that are not ok/info. */
  open: number;
}

export const BACKUPS_DOC_URL = "https://github.com/gochicoree/chicoree#operations";

export async function adminSetupChecklist(userId: string): Promise<AdminChecklist> {
  const [settings, schedules, health, dismissedRow, scanning, scanner] = await Promise.all([
    getInstanceSettings(),
    listSchedules(),
    quickHealth(),
    db.execute(sql`SELECT admin_checklist_dismissed_at AS at FROM user_settings WHERE user_id = ${userId}`),
    scanningEnabled(),
    scannerLabel(),
  ]);
  const providers = [
    settings.github.enabled && settings.github.clientId ? "GitHub" : null,
    settings.google.enabled && settings.google.clientId ? "Google" : null,
    settings.oidc.enabled && settings.oidc.issuer ? settings.oidc.name || "OIDC" : null,
    settings.ldap.enabled && settings.ldap.url ? settings.ldap.name || "LDAP" : null,
  ].filter((p): p is string => !!p);
  const gc = schedules.get("gc");
  const retention = schedules.get("retention");
  const brandingSet =
    settings.sources.branding === "database" ||
    settings.branding.instanceName !== DEFAULT_BRANDING.instanceName ||
    !!settings.branding.logoDataUrl ||
    !!settings.branding.accentColor;
  const rateLimits = [settings.ratelimit.anonymous && `anonymous ${settings.ratelimit.anonymous}`, settings.ratelimit.authenticated && `authenticated ${settings.ratelimit.authenticated}`].filter(Boolean);

  const rows: ChecklistRow[] = [
    {
      key: "smtp",
      title: "Outgoing email",
      status: settings.smtp.host ? "ok" : "error",
      summary: settings.smtp.host
        ? `SMTP via ${settings.smtp.host}:${settings.smtp.port} (${settings.sources.smtp})`
        : "No SMTP host: invitations, password resets, email codes and notifications cannot be sent.",
      href: "/admin/email",
      linkLabel: "Email settings",
    },
    {
      key: "signin",
      title: "Sign-in methods",
      status: "ok",
      summary: providers.length > 0 ? `Password sign-in plus ${providers.join(", ")}.` : "Password sign-in (with passkeys, magic links and 2FA). No external provider configured.",
      href: "/admin/auth",
      linkLabel: "Auth providers",
    },
    {
      key: "scanner",
      title: "Vulnerability scanning",
      status: scanning ? "ok" : "warn",
      summary: scanning ? `${scanner}; images are scanned on push.` : "No scanner configured: images are stored but never scanned.",
      href: "/admin/scanning",
      linkLabel: "Scanning",
    },
    {
      key: "metrics",
      title: "Prometheus metrics",
      status: settings.metrics.enabled ? "ok" : "warn",
      summary: settings.metrics.enabled
        ? settings.metrics.token
          ? "Endpoint enabled and protected by a bearer token."
          : "Endpoint enabled, but without a token every scrape is refused."
        : "The /api/metrics endpoint is off; nothing is exported to Prometheus.",
      href: "/admin/metrics",
      linkLabel: "Metrics",
    },
    {
      key: "gc",
      title: "Garbage collection schedule",
      status: gc?.enabled ? "ok" : "warn",
      summary: gc?.enabled ? `Runs on “${gc.cron}” (${gc.timezone}).` : "Not scheduled: unreferenced layers are never reclaimed on their own.",
      href: "/admin/jobs/gc",
      linkLabel: "Jobs",
    },
    {
      key: "retention",
      title: "Retention schedule",
      status: retention?.enabled ? "ok" : "warn",
      summary: retention?.enabled ? `Runs on “${retention.cron}” (${retention.timezone}).` : "Not scheduled: retention policies are only applied when the job runs.",
      href: "/admin/jobs/retention",
      linkLabel: "Jobs",
    },
    {
      key: "branding",
      title: "Branding",
      status: brandingSet ? "ok" : "info",
      summary: brandingSet ? `Instance name “${settings.branding.instanceName}”.` : "Still the default name and mark. Give the instance a name, a logo and an accent colour.",
      href: "/admin/branding",
      linkLabel: "Branding",
    },
    {
      key: "ratelimit",
      title: "Pull rate limits",
      status: rateLimits.length > 0 ? "ok" : "warn",
      summary: rateLimits.length > 0 ? `Limits: ${rateLimits.join(", ")}.` : "No pull limits: a single client can hammer the registry without bound.",
      href: "/admin/settings/limits",
      linkLabel: "Rate limits",
    },
    {
      key: "backups",
      title: "Backups",
      status: "info",
      summary: "Back up Postgres and the blob storage together on a schedule; manifests live in the database, layer bytes in storage.",
      href: BACKUPS_DOC_URL,
      linkLabel: "Operations guide",
      external: true,
    },
    {
      key: "health",
      title: "Health checks",
      status: health.status === "ok" ? "ok" : "error",
      summary:
        health.status === "ok"
          ? `Database (${health.database.latencyMs} ms) and registry (${health.registry.latencyMs} ms) answer.`
          : [!health.database.ok && `database: ${health.database.error ?? "unreachable"}`, !health.registry.ok && `registry: ${health.registry.error ?? "unreachable"}`]
              .filter(Boolean)
              .join("; "),
      href: "/admin/health",
      linkLabel: "Health",
    },
  ];
  return {
    rows,
    dismissed: !!dismissedRow.rows[0]?.at,
    open: rows.filter((r) => r.status === "warn" || r.status === "error").length,
  };
}
