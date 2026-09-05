// Chat renderings of webhook events. A webhook with a chat format receives
// the same event as a JSON hook, rendered as one short message: a title, a
// few lines of detail and a link back to the registry — encoded for the
// incoming-webhook API of Slack, Discord or Microsoft Teams, or as a plain
// { text } document that Mattermost, Google Chat and Rocket.Chat accept.
// No database access: everything comes from the payload.
import type { WebhookEnvelope } from "./webhooks";
import type { WebhookFormat } from "./webhooks-shared";

export type ChatLevel = "info" | "success" | "warning" | "danger";

export interface ChatMessage {
  title: string;
  /** Plain-text detail lines, in order; markdown-free so every service renders them alike. */
  lines: string[];
  /** Where the message should link to (the image, repository or organization). */
  url: string | null;
  level: ChatLevel;
  /** The registry host, for the footer. */
  registry: string;
  timestamp: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function shortDigest(d: unknown): string | null {
  const s = str(d);
  return s ? s.replace(/^sha256:/, "").slice(0, 12) : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function severitySummary(summary: unknown): string | null {
  const s = rec(summary);
  const order = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
  const parts = order.filter((k) => num(s[k])).map((k) => `${s[k]} ${k === "Unknown" ? "unrated" : k.toLowerCase()}`);
  if (parts.length === 0) return Object.keys(s).length ? "no findings" : null;
  return parts.join(", ");
}

function actorLine(actor: unknown): string | null {
  const a = rec(actor);
  const name = str(a.name);
  const type = str(a.type);
  if (!name && !type) return null;
  if (type === "sa") return `by service account ${name ?? a.id ?? ""}`.trim();
  if (type === "mirror") return "by a mirror";
  if (type === "proxy") return "by the proxy cache";
  return name ? `by ${name}` : null;
}

/** One message per event; unknown events fall back to their scalar fields. */
export function chatMessage(payload: WebhookEnvelope): ChatMessage {
  const p = payload as unknown as Rec;
  const repo = payload.repository;
  const repoPath = repo?.path ?? str(rec(p.repository).path) ?? "";
  const repoUrl = repo?.url ?? null;
  const image = rec(p.image);
  const tag = str(p.tag);
  const ref = tag ? `${repoPath}:${tag}` : shortDigest(image.digest ?? p.digest) ? `${repoPath}@${shortDigest(image.digest ?? p.digest)}` : repoPath;
  const imageUrl = str(image.url) ?? (tag && repoUrl ? `${repoUrl}/tags/${encodeURIComponent(tag)}` : repoUrl);
  const base = { registry: payload.registry, timestamp: payload.timestamp };

  switch (payload.event) {
    case "push":
    case "test": {
      const lines: string[] = [];
      const size = num(image.totalSize);
      const platform = rec(image.platform);
      const plat = [str(platform.os), str(platform.architecture), str(platform.variant)].filter(Boolean).join("/");
      const detail = [
        shortDigest(image.digest) ? `digest ${shortDigest(image.digest)}` : null,
        size !== null ? formatBytes(size) : null,
        image.isIndex === true ? "multi-arch index" : plat || null,
      ].filter(Boolean);
      if (detail.length) lines.push(detail.join(" · "));
      const actor = actorLine(p.actor);
      if (actor) lines.push(`Pushed ${actor}`);
      if (payload.event === "test") lines.push("This is a test delivery.");
      return { ...base, title: `${payload.event === "test" ? "Test: " : ""}Pushed ${ref}`, lines, url: imageUrl, level: "success" };
    }
    case "delete": {
      const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
      const what = tags.length > 0 ? tags.map((t) => `${repoPath}:${t}`).join(", ") : ref;
      const actor = actorLine(p.actor);
      return { ...base, title: `Deleted ${what}`, lines: actor ? [`Deleted ${actor}`] : [], url: repoUrl, level: "warning" };
    }
    case "scan.completed": {
      const scan = rec(p.scan);
      const summary = severitySummary(scan.summary);
      const blocked = scan.blocked === true;
      return {
        ...base,
        title: `Scan finished for ${ref}`,
        lines: [summary ? `Findings: ${summary}` : "No findings", blocked ? `Pulls are blocked: ${str(scan.reason) ?? "policy threshold"}` : "Pulls are not blocked"],
        url: imageUrl,
        level: blocked ? "danger" : "info",
      };
    }
    case "scan.blocked":
      return { ...base, title: `Pull blocked for ${ref}`, lines: [str(p.reason) ?? "Vulnerability policy threshold reached"], url: imageUrl, level: "danger" };
    case "signature.blocked":
      return { ...base, title: `Signature required for ${ref}`, lines: [str(p.reason) ?? "No signature from a trusted key"], url: imageUrl, level: "danger" };
    case "mirror.completed": {
      const mirror = rec(p.mirror);
      const run = rec(p.run);
      const counts = [
        num(run.imported) !== null ? `${run.imported} imported` : null,
        num(run.skipped) !== null ? `${run.skipped} unchanged` : null,
        num(run.failed) !== null && num(run.failed)! > 0 ? `${run.failed} failed` : null,
      ].filter(Boolean);
      return {
        ...base,
        title: `Mirror ${str(run.status) ?? "finished"}: ${repoPath}`,
        lines: [`Source ${str(mirror.source) ?? "unknown"}`, ...(counts.length ? [counts.join(", ")] : [])],
        url: repoUrl ? `${repoUrl}/settings/mirror` : null,
        level: str(run.status) === "failed" ? "danger" : "success",
      };
    }
    case "mirror.failed": {
      const mirror = rec(p.mirror);
      const run = rec(p.run);
      return {
        ...base,
        title: `Mirror failed: ${repoPath}`,
        lines: [`Source ${str(mirror.source) ?? "unknown"}`, `Error: ${str(run.error) ?? "unknown"}`],
        url: repoUrl ? `${repoUrl}/settings/mirror` : null,
        level: "danger",
      };
    }
    case "retention.completed": {
      const deleted = Array.isArray(p.deletedTags) ? (p.deletedTags as unknown[]).length : 0;
      const dryRun = p.dryRun === true;
      return {
        ...base,
        title: `${dryRun ? "Retention preview" : "Retention run"}: ${repoPath}`,
        lines: [
          dryRun ? `${deleted} tag${deleted === 1 ? "" : "s"} would be deleted` : `${deleted} tag${deleted === 1 ? "" : "s"} deleted`,
          ...(str(p.policy) ? [`Policy: ${str(p.policy)}`] : []),
        ],
        url: repoUrl,
        level: deleted > 0 && !dryRun ? "warning" : "info",
      };
    }
    case "repository.renamed": {
      const prev = rec(p.previous);
      return { ...base, title: `Renamed ${str(prev.path) ?? "repository"} → ${repoPath}`, lines: [actorLine(p.actor) ?? ""].filter(Boolean), url: repoUrl, level: "info" };
    }
    case "repository.transferred": {
      const prev = rec(p.previous);
      return { ...base, title: `Moved ${str(prev.path) ?? "repository"} → ${repoPath}`, lines: [actorLine(p.actor) ?? ""].filter(Boolean), url: repoUrl, level: "info" };
    }
    case "quota.warning": {
      const q = rec(p.quota);
      const org = str(rec(p.organization).slug) ?? "organization";
      return {
        ...base,
        title: `Quota warning: ${org} at ${num(q.percent) ?? num(q.threshold) ?? "?"} % of its ${str(q.kind) ?? ""} limit`.replace(/\s+limit/, " limit"),
        lines: [`${q.used ?? "?"} of ${q.limit ?? "?"} used`],
        url: null,
        level: (num(q.threshold) ?? 0) >= 95 ? "danger" : "warning",
      };
    }
    default: {
      const lines = Object.entries(p)
        .filter(([k, v]) => !["event", "deliveryId", "timestamp", "registry", "repository"].includes(k) && (typeof v === "string" || typeof v === "number"))
        .map(([k, v]) => `${k}: ${v}`);
      return { ...base, title: `${payload.event}${repoPath ? ` · ${repoPath}` : ""}`, lines, url: repoUrl, level: "info" };
    }
  }
}

const COLORS: Record<ChatLevel, { hex: string; int: number; teams: string }> = {
  info: { hex: "#2f6fed", int: 0x2f6fed, teams: "accent" },
  success: { hex: "#2e9e5b", int: 0x2e9e5b, teams: "good" },
  warning: { hex: "#d9822b", int: 0xd9822b, teams: "warning" },
  danger: { hex: "#d64545", int: 0xd64545, teams: "attention" },
};

function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The request body for one chat service. */
export function encodeChatMessage(format: WebhookFormat, m: ChatMessage): unknown {
  const footer = `${m.registry} · ${new Date(m.timestamp).toUTCString()}`;
  switch (format) {
    case "slack": {
      const text = [m.url ? `*<${m.url}|${slackEscape(m.title)}>*` : `*${slackEscape(m.title)}*`, ...m.lines.map(slackEscape)].join("\n");
      return {
        text: m.title,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          { type: "context", elements: [{ type: "mrkdwn", text: slackEscape(footer) }] },
        ],
      };
    }
    case "discord":
      return {
        embeds: [
          {
            title: m.title.slice(0, 256),
            url: m.url ?? undefined,
            description: m.lines.join("\n").slice(0, 4096) || undefined,
            color: COLORS[m.level].int,
            footer: { text: m.registry },
            timestamp: m.timestamp,
          },
        ],
      };
    case "teams":
      return {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              msteams: { width: "Full" },
              body: [
                { type: "TextBlock", text: m.title, weight: "Bolder", size: "Medium", wrap: true, color: COLORS[m.level].teams },
                ...m.lines.map((line) => ({ type: "TextBlock", text: line, wrap: true, spacing: "Small" })),
                { type: "TextBlock", text: footer, isSubtle: true, size: "Small", wrap: true, spacing: "Medium" },
              ],
              actions: m.url ? [{ type: "Action.OpenUrl", title: "Open in the registry", url: m.url }] : [],
            },
          },
        ],
      };
    case "text":
    default:
      return { text: [m.url ? `**${m.title}** — ${m.url}` : `**${m.title}**`, ...m.lines, `_${footer}_`].join("\n") };
  }
}
