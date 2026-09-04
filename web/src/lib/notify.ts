// Notification framework: one entry point, notify(event), that turns
// something that happened (a blocked image, a failed mirror, a quota
// threshold) into emails for the people responsible — organization owners
// and admins, or instance administrators — honouring each user's
// preferences, and forwards the event to organization webhooks that
// subscribed to it.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  member,
  mirrors,
  notificationPreferences,
  organization,
  repositories,
  repositoryWebhooks,
  user as userTable,
} from "@/db/schema";
import type { SeveritySummary } from "@/components/severity";
import { buttonHtml, mailLayout, sendMail } from "./email";
import { env } from "./env";
import { getInstanceSettings } from "./instance-settings";
import { formatBytes } from "./format";
import { imageReference } from "./library";
import { defaultEmailFor, type NotificationEvent } from "./notify-shared";
import { getOrgLimits, getOrgUsage } from "./quota";
import { emitOrganizationEvent, emitRepositoryEvent, tagsForDigest } from "./webhooks";

export type { NotificationEvent };

export type QuotaKind = "storage" | "public repositories" | "private repositories";

export type NotifyInput =
  | { event: "scan.blocked"; repositoryId: string; blocked: { digest: string; reason: string }[] }
  | {
      event: "scan.completed";
      repositoryId: string;
      digest: string;
      summary: SeveritySummary | null;
      blockedReason: string | null;
      /** Backend label for the message ("Clair", "Trivy"). */
      scanner?: string;
    }
  | { event: "mirror.failed"; mirrorId: string; repositoryId: string; runId: string; error: string }
  | {
      event: "webhook.failed";
      hookId: string;
      deliveryId: string;
      eventName: string;
      statusCode: number | null;
      error: string;
      attempts: number;
    }
  | { event: "quota.warning"; organizationId: string; kind: QuotaKind; used: number; limit: number; threshold: 80 | 95 }
  | { event: "job.failed"; job: string; runId: string; error: string; triggeredBy: string }
  | {
      event: "token.expiring";
      kind: "pat" | "sa";
      id: string;
      name: string;
      expiresAt: Date;
      /** Personal access tokens: the owner. */
      userId: string | null;
      /** Service accounts: the organization whose managers are told. */
      organizationId: string | null;
    };

interface Message {
  subject: string;
  text: string;
  /** Rendered with the instance name from the branding settings at send time. */
  html: (brand: string) => string;
}

interface Recipient {
  id: string;
  email: string;
  name: string;
}

// --- Recipients ----------------------------------------------------------------

async function orgManagers(organizationId: string): Promise<Recipient[]> {
  const rows = await db
    .select({ id: userTable.id, email: userTable.email, name: userTable.name, banned: userTable.banned })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.organizationId, organizationId), inArray(member.role, ["owner", "admin"])));
  return rows.filter((r) => !r.banned && r.email).map(({ id, email, name }) => ({ id, email, name }));
}

async function instanceAdmins(): Promise<Recipient[]> {
  const rows = await db
    .select({ id: userTable.id, email: userTable.email, name: userTable.name, banned: userTable.banned })
    .from(userTable)
    .where(eq(userTable.role, "admin"));
  return rows.filter((r) => !r.banned && r.email).map(({ id, email, name }) => ({ id, email, name }));
}

/** Drop recipients who switched email off for this event (defaults from notify-shared). */
async function applyPreferences(event: NotificationEvent, recipients: Recipient[]): Promise<Recipient[]> {
  if (recipients.length === 0) return [];
  const prefs = await db.query.notificationPreferences.findMany({
    where: and(
      eq(notificationPreferences.event, event),
      inArray(
        notificationPreferences.userId,
        recipients.map((r) => r.id),
      ),
    ),
  });
  const byUser = new Map(prefs.map((p) => [p.userId, p.email]));
  const fallback = defaultEmailFor(event);
  return recipients.filter((r) => byUser.get(r.id) ?? fallback);
}

// --- Templates -------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function link(href: string, label: string): string {
  return `<a href="${href}" style="color:#0f3a4d">${esc(label)}</a>`;
}

function summaryLine(summary: SeveritySummary | null): string {
  if (!summary) return "no findings recorded";
  const parts = (["Critical", "High", "Medium", "Low", "Negligible", "Unknown"] as (keyof SeveritySummary)[])
    .filter((k) => (summary[k] ?? 0) > 0)
    .map((k) => `${summary[k]} ${k.toLowerCase()}`);
  return parts.length ? parts.join(", ") : "no findings";
}

interface RepoContext {
  repo: typeof repositories.$inferSelect;
  org: typeof organization.$inferSelect;
  path: string;
  url: string;
}

async function repoContext(repositoryId: string): Promise<RepoContext | null> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return null;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return null;
  return { repo, org, path: `${org.slug}/${repo.name}`, url: `${env.appUrl}/${org.slug}/${repo.name}` };
}

const FOOTER = "You receive this because you manage this organization. Change what is sent to you under Settings → Notifications.";
const ADMIN_FOOTER = "You receive this as an instance administrator. Change what is sent to you under Settings → Notifications.";

function compose(title: string, subject: string, lines: string[], html: string[], action?: { href: string; label: string }, footer = FOOTER): Message {
  const text = [...lines, "", action ? `${action.label}: ${action.href}` : "", "", footer].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const body = `${html.map((h) => `<p>${h}</p>`).join("")}${action ? `<p style="margin-top:20px">${buttonHtml(action.href, action.label)}</p>` : ""}`;
  return { subject, text, html: (brand) => mailLayout(title, body, brand, footer) };
}

// --- Fan-out -----------------------------------------------------------------------

async function send(event: NotificationEvent, recipients: Recipient[], message: Message): Promise<void> {
  const targets = await applyPreferences(event, recipients);
  if (targets.length === 0) {
    console.log(`[notify] ${event}: no recipients after preferences`);
    return;
  }
  const brand = (await getInstanceSettings()).branding.instanceName || "Chicorée";
  for (const r of targets) {
    try {
      await sendMail({ to: r.email, subject: message.subject, text: message.text, html: message.html(brand) });
    } catch (err) {
      console.error(`[notify] ${event}: email to ${r.email} failed:`, err);
    }
  }
}

/**
 * Notify the right people about an event, and forward it to organization
 * webhooks that subscribed (email preferences never affect webhooks).
 */
export async function notify(input: NotifyInput): Promise<void> {
  switch (input.event) {
    case "scan.blocked": {
      const ctx = await repoContext(input.repositoryId);
      if (!ctx || input.blocked.length === 0) return;
      const items = await Promise.all(
        input.blocked.map(async (b) => ({ ...b, tags: await tagsForDigest(ctx.repo.id, b.digest) })),
      );
      const describe = (i: (typeof items)[number]) =>
        `${i.tags.length ? i.tags.map((t) => `${ctx.path}:${t}`).join(", ") : `${ctx.path}@${i.digest.slice(0, 19)}`} — ${i.reason}`;
      const first = items[0];
      const subject =
        items.length === 1
          ? `Pull blocked: ${ctx.path}${first.tags[0] ? `:${first.tags[0]}` : ""}`
          : `Pulls blocked: ${items.length} images in ${ctx.path}`;
      const message = compose(
        "Pull blocked by vulnerability scan",
        subject,
        [
          `The pull policy of ${ctx.org.name} now blocks ${items.length === 1 ? "an image" : `${items.length} images`} in ${ctx.path}:`,
          ...items.map((i) => `  • ${describe(i)}`),
          "",
          "docker pull answers 403 for these images until a re-scan clears them or the policy changes.",
        ],
        [
          `The pull policy of <strong>${esc(ctx.org.name)}</strong> now blocks ${items.length === 1 ? "an image" : `${items.length} images`} in ${link(ctx.url, ctx.path)}:`,
          `<ul>${items.map((i) => `<li>${esc(describe(i))}</li>`).join("")}</ul>`,
          "<code>docker pull</code> answers 403 for these images until a re-scan clears them or the policy changes.",
        ],
        { href: `${ctx.url}/tags/${encodeURIComponent(first.tags[0] ?? first.digest)}`, label: "Open the image" },
      );
      await send("scan.blocked", await orgManagers(ctx.org.id), message);
      for (const i of items) {
        await emitRepositoryEvent(ctx.repo.id, "scan.blocked", {
          tag: i.tags[0] ?? null,
          tags: i.tags,
          image: {
            digest: i.digest,
            reference: imageReference(env.registryHost, ctx.org.slug, ctx.repo.name, i.tags[0] ?? i.digest),
            url: `${ctx.url}/tags/${encodeURIComponent(i.tags[0] ?? i.digest)}`,
          },
          reason: i.reason,
        }).catch((err) => console.error("scan.blocked webhook failed:", err));
      }
      return;
    }

    case "scan.completed": {
      const ctx = await repoContext(input.repositoryId);
      if (!ctx) return;
      const tags = await tagsForDigest(ctx.repo.id, input.digest);
      const ref = tags[0] ?? input.digest;
      const url = `${ctx.url}/tags/${encodeURIComponent(ref)}`;
      const label = `${ctx.path}${tags[0] ? `:${tags[0]}` : `@${input.digest.slice(0, 19)}`}`;
      const message = compose(
        "Scan completed",
        `Scan completed: ${label} (${summaryLine(input.summary)})`,
        [
          `${input.scanner ?? "The vulnerability scanner"} finished scanning ${label}.`,
          `Findings: ${summaryLine(input.summary)}.`,
          input.blockedReason ? `Pulls are blocked: ${input.blockedReason}.` : "Pulls are not blocked by the policy.",
        ],
        [
          `${esc(input.scanner ?? "The vulnerability scanner")} finished scanning ${link(url, label)}.`,
          `Findings: <strong>${esc(summaryLine(input.summary))}</strong>.`,
          input.blockedReason ? `Pulls are blocked: ${esc(input.blockedReason)}.` : "Pulls are not blocked by the policy.",
        ],
        { href: url, label: "View the report" },
      );
      await send("scan.completed", await orgManagers(ctx.org.id), message);
      await emitRepositoryEvent(ctx.repo.id, "scan.completed", {
        tag: tags[0] ?? null,
        tags,
        image: { digest: input.digest, reference: imageReference(env.registryHost, ctx.org.slug, ctx.repo.name, ref), url },
        scan: { status: "scanned", summary: input.summary, blocked: !!input.blockedReason, reason: input.blockedReason },
      }).catch((err) => console.error("scan.completed webhook failed:", err));
      return;
    }

    case "mirror.failed": {
      const ctx = await repoContext(input.repositoryId);
      if (!ctx) return;
      const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.id, input.mirrorId) });
      const source = mirror?.source ?? "unknown source";
      const url = `${ctx.url}/settings/mirror`;
      const message = compose(
        "Mirror failed",
        `Mirror failed: ${ctx.path} from ${source}`,
        [`The mirror of ${source} into ${ctx.path} failed.`, `Error: ${input.error}`],
        [`The mirror of <code>${esc(source)}</code> into ${link(ctx.url, ctx.path)} failed.`, `Error: <code>${esc(input.error)}</code>`],
        { href: url, label: "Open mirror settings" },
      );
      await send("mirror.failed", await orgManagers(ctx.org.id), message);
      await emitRepositoryEvent(ctx.repo.id, "mirror.failed", {
        mirror: { id: input.mirrorId, source },
        run: { id: input.runId, status: "failed", error: input.error },
      }).catch((err) => console.error("mirror.failed webhook failed:", err));
      return;
    }

    case "webhook.failed": {
      const hook = await db.query.repositoryWebhooks.findFirst({ where: eq(repositoryWebhooks.id, input.hookId) });
      if (!hook) return;
      let orgId = hook.organizationId;
      let where = "";
      let settingsUrl = "";
      if (hook.repositoryId) {
        const ctx = await repoContext(hook.repositoryId);
        if (!ctx) return;
        orgId = ctx.org.id;
        where = ctx.path;
        settingsUrl = `${ctx.url}/settings/webhooks`;
      } else if (orgId) {
        const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
        if (!org) return;
        where = `organization ${org.name}`;
        settingsUrl = `${env.appUrl}/${org.slug}/settings/webhooks`;
      }
      if (!orgId) return;
      const status = input.statusCode ? `HTTP ${input.statusCode}` : "no response";
      const message = compose(
        "Webhook delivery failed",
        `Webhook failed: ${hook.name} (${where})`,
        [
          `The webhook "${hook.name}" of ${where} could not deliver a ${input.eventName} event to ${hook.url}.`,
          `Result after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"}: ${status} — ${input.error}`,
          "Deliveries retry on network errors and 5xx answers; a 4xx answer is taken as the receiver's final word.",
        ],
        [
          `The webhook <strong>${esc(hook.name)}</strong> of ${esc(where)} could not deliver a <code>${esc(input.eventName)}</code> event to <code>${esc(hook.url)}</code>.`,
          `Result after ${input.attempts} attempt${input.attempts === 1 ? "" : "s"}: <strong>${esc(status)}</strong> — ${esc(input.error)}`,
          "Deliveries retry on network errors and 5xx answers; a 4xx answer is taken as the receiver's final word.",
        ],
        { href: settingsUrl, label: "Open the delivery log" },
      );
      await send("webhook.failed", await orgManagers(orgId), message);
      return;
    }

    case "quota.warning": {
      const org = await db.query.organization.findFirst({ where: eq(organization.id, input.organizationId) });
      if (!org) return;
      const fmt = (n: number) => (input.kind === "storage" ? formatBytes(n) : String(n));
      const percent = Math.round((input.used / input.limit) * 100);
      const url = `${env.appUrl}/${org.slug}`;
      const consequence =
        input.kind === "storage"
          ? "Once the limit is reached, pushes that need new layers are refused by the registry."
          : `Once the limit is reached, no more ${input.kind} can be created in this organization.`;
      const message = compose(
        `${input.threshold} % of the ${input.kind} limit used`,
        `Quota warning: ${org.name} at ${percent} % of its ${input.kind} limit`,
        [
          `${org.name} uses ${fmt(input.used)} of its ${fmt(input.limit)} ${input.kind} limit (${percent} %).`,
          consequence,
          "Free up space or ask an administrator to raise the limit.",
        ],
        [
          `<strong>${esc(org.name)}</strong> uses <strong>${esc(fmt(input.used))}</strong> of its ${esc(fmt(input.limit))} ${input.kind} limit (${percent} %).`,
          esc(consequence),
          "Free up space or ask an administrator to raise the limit.",
        ],
        { href: url, label: "Open the organization" },
      );
      await send("quota.warning", await orgManagers(org.id), message);
      await emitOrganizationEvent(org.id, "quota.warning", {
        quota: { kind: input.kind, used: input.used, limit: input.limit, percent, threshold: input.threshold },
      }).catch((err) => console.error("quota.warning webhook failed:", err));
      return;
    }

    case "job.failed": {
      const url = `${env.appUrl}/admin/jobs`;
      const trigger =
        input.triggeredBy === "schedule" ? "on schedule" : input.triggeredBy === "api-token" ? "from the jobs API" : "manually";
      const message = compose(
        "Job failed",
        `Job failed: ${input.job}`,
        [`The ${input.job} job, started ${trigger}, failed.`, `Error: ${input.error}`, `Run id: ${input.runId}`],
        [
          `The <strong>${esc(input.job)}</strong> job, started ${trigger}, failed.`,
          `Error: <code>${esc(input.error)}</code>`,
          `Run id: <code>${esc(input.runId)}</code>`,
        ],
        { href: url, label: "Open the jobs page" },
        ADMIN_FOOTER,
      );
      await send("job.failed", await instanceAdmins(), message);
      return;
    }

    case "token.expiring": {
      const days = Math.max(0, Math.ceil((input.expiresAt.getTime() - Date.now()) / 86_400_000));
      const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
      const date = input.expiresAt.toISOString().slice(0, 10);
      if (input.kind === "pat") {
        if (!input.userId) return;
        const u = await db.query.user.findFirst({ where: eq(userTable.id, input.userId) });
        if (!u || u.banned || !u.email) return;
        const url = `${env.appUrl}/settings/tokens`;
        const message = compose(
          "Access token expiring",
          `Access token "${input.name}" expires ${when}`,
          [
            `Your personal access token "${input.name}" expires ${when} (${date}).`,
            "docker login and CI jobs using it stop working at that moment. Rotate it under Settings → Access tokens to get a replacement with the same settings.",
          ],
          [
            `Your personal access token <strong>${esc(input.name)}</strong> expires ${when} (${date}).`,
            "<code>docker login</code> and CI jobs using it stop working at that moment. Rotate it under Settings → Access tokens to get a replacement with the same settings.",
          ],
          { href: url, label: "Open access tokens" },
          "You receive this because the token belongs to your account. Change what is sent to you under Settings → Notifications.",
        );
        await send("token.expiring", [{ id: u.id, email: u.email, name: u.name }], message);
        return;
      }
      if (!input.organizationId) return;
      const org = await db.query.organization.findFirst({ where: eq(organization.id, input.organizationId) });
      if (!org) return;
      const url = `${env.appUrl}/${org.slug}/service-accounts`;
      const message = compose(
        "Service account expiring",
        `Service account "${input.name}" of ${org.name} expires ${when}`,
        [
          `The service account "${input.name}" of ${org.name} expires ${when} (${date}).`,
          "Pipelines using its credential stop working at that moment. Rotate it under Organization → Service accounts and update the secret in your CI.",
        ],
        [
          `The service account <strong>${esc(input.name)}</strong> of <strong>${esc(org.name)}</strong> expires ${when} (${date}).`,
          "Pipelines using its credential stop working at that moment. Rotate it under Organization → Service accounts and update the secret in your CI.",
        ],
        { href: url, label: "Open service accounts" },
      );
      await send("token.expiring", await orgManagers(org.id), message);
      return;
    }
  }
}

// --- Quota thresholds -------------------------------------------------------------------

const THRESHOLDS: (80 | 95)[] = [95, 80];

/**
 * Compare an organization's usage with its limits and send quota.warning
 * once per threshold crossing (80 %, 95 %) per organization per 24 hours.
 * Called after pushes, repository creation and limit changes.
 */
export async function checkQuotaWarnings(organizationId: string): Promise<void> {
  const [usage, limits] = await Promise.all([getOrgUsage(organizationId), getOrgLimits(organizationId)]);
  const checks: { kind: QuotaKind; used: number; limit: number | null }[] = [
    { kind: "storage", used: usage.storageBytes, limit: limits.maxStorageBytes },
    { kind: "public repositories", used: usage.publicRepos, limit: limits.maxPublicRepos },
    { kind: "private repositories", used: usage.privateRepos, limit: limits.maxPrivateRepos },
  ];
  for (const c of checks) {
    if (c.limit === null || c.limit <= 0) continue;
    const percent = (c.used / c.limit) * 100;
    const threshold = THRESHOLDS.find((t) => percent >= t);
    if (!threshold) continue;
    const key = `quota.warning:${organizationId}:${c.kind.replace(/\s+/g, "-")}:${threshold}`;
    // Atomic "send at most once per 24 h": the upsert only returns a row when
    // there was none, or the stored one is older than a day.
    const { rows } = await db.execute(sql`
      INSERT INTO notification_state (key, sent_at) VALUES (${key}, now())
      ON CONFLICT (key) DO UPDATE SET sent_at = now()
      WHERE notification_state.sent_at < now() - interval '24 hours'
      RETURNING key`);
    if (rows.length === 0) continue;
    await notify({ event: "quota.warning", organizationId, kind: c.kind, used: c.used, limit: c.limit, threshold }).catch(
      (err) => console.error("quota.warning notification failed:", err),
    );
  }
}

/** Convenience for callers that only know the repository. */
export async function checkQuotaWarningsForRepository(repositoryId: string): Promise<void> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (repo) await checkQuotaWarnings(repo.organizationId);
}
