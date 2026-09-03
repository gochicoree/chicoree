// Audit log: pure helpers shared by the server queries, the pages and the CSV
// export (no database imports here).

/** Action prefixes offered in the filter dropdown, with a readable label. */
export const AUDIT_ACTION_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "auth", label: "Authentication" },
  { prefix: "admin", label: "Administration" },
  { prefix: "settings", label: "Instance settings" },
  { prefix: "org", label: "Organizations" },
  { prefix: "repo", label: "Repositories" },
  { prefix: "tag", label: "Tags" },
  { prefix: "token", label: "Access tokens" },
  { prefix: "sa", label: "Service accounts" },
  { prefix: "webhook", label: "Webhooks" },
  { prefix: "mirror", label: "Mirrors" },
  { prefix: "policy", label: "Pull policies" },
  { prefix: "scan", label: "Scans" },
  { prefix: "job", label: "Jobs" },
  { prefix: "user", label: "User settings" },
];

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_MAX = 10_000;

export interface AuditFilter {
  q: string;
  action: string;
  organizationId: string;
  from: string;
  to: string;
  page: number;
}

/** Read the filter from URL search params (also used by the CSV route). */
export function auditFilterFromParams(params: Record<string, string | string[] | undefined> | URLSearchParams): AuditFilter {
  const get = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const page = Number(get("page"));
  return {
    q: get("q").trim().slice(0, 200),
    action: get("action").trim().slice(0, 64),
    organizationId: get("org").trim().slice(0, 64),
    from: validDate(get("from")),
    to: validDate(get("to")),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function validDate(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

/** Query string for links that keep the current filter (page optional). */
export function auditFilterQuery(f: AuditFilter, page?: number): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.action) p.set("action", f.action);
  if (f.organizationId) p.set("org", f.organizationId);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (page && page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export interface AuditRow {
  id: number;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  impersonatorId: string | null;
  action: string;
  organizationId: string | null;
  organizationSlug: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** Tone for the action badge: failures and destructive verbs stand out. */
export function auditActionTone(action: string): "neutral" | "ok" | "danger" | "accent" | "info" {
  if (action.endsWith(".failed") || action.endsWith(".ban")) return "danger";
  if (/\.(delete|remove|revoke)$/.test(action)) return "danger";
  if (/\.(create|add|accept|enable|start)$/.test(action) || action === "auth.sign_up") return "ok";
  if (action.startsWith("admin.") || action.startsWith("settings.")) return "accent";
  return "info";
}

const CSV_COLUMNS = [
  "id", "created_at", "actor_type", "actor_id", "actor_label", "impersonator_id", "action",
  "organization_id", "organization_slug", "target_type", "target_id", "target_label", "details", "ip", "user_agent",
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function auditRowsToCsv(rows: AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id, r.createdAt, r.actorType, r.actorId, r.actorLabel, r.impersonatorId, r.action,
        r.organizationId, r.organizationSlug, r.targetType, r.targetId, r.targetLabel, r.details, r.ip, r.userAgent,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Keys that must never end up in `details`, whatever the caller passes. */
const SECRET_KEY_RE = /(secret|password|passwd|privatekey|private_key|authorization|cookie)$/i;
const SECRET_KEYS = new Set(["token", "pass", "secret", "key", "otp", "code", "backupcodes", "idtoken", "accesstoken", "refreshtoken"]);

/** Strip anything that looks like a credential and cap the size. */
export function redactDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined) continue;
    const key = k.replace(/[^a-z]/gi, "").toLowerCase();
    if (SECRET_KEY_RE.test(k) || SECRET_KEYS.has(key)) continue;
    out[k] = typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  const json = JSON.stringify(out);
  if (json.length > 4000) return { truncated: true, keys: Object.keys(out) };
  return Object.keys(out).length ? out : null;
}
