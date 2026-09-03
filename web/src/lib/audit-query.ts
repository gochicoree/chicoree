// Read side of the audit log: filtered, paginated listing for the admin and
// organization pages plus the CSV export.
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { AUDIT_EXPORT_MAX, AUDIT_PAGE_SIZE, type AuditFilter, type AuditRow } from "./audit-shared";

interface QueryOptions {
  filter: AuditFilter;
  /** Restrict to one organization (org pages); overrides filter.organizationId. */
  organizationId?: string;
  limit?: number;
  offset?: number;
}

function whereClause({ filter, organizationId }: QueryOptions): SQL {
  const conds: SQL[] = [sql`true`];
  const org = organizationId ?? filter.organizationId;
  if (org) conds.push(sql`a.organization_id = ${org}`);
  if (filter.action) {
    conds.push(sql`(a.action = ${filter.action} OR a.action LIKE ${filter.action + ".%"})`);
  }
  if (filter.q) {
    const like = `%${filter.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      sql`(a.actor_label ILIKE ${like} OR a.target_label ILIKE ${like} OR a.action ILIKE ${like} OR a.actor_id = ${filter.q} OR a.target_id = ${filter.q} OR a.ip = ${filter.q})`,
    );
  }
  if (filter.from) conds.push(sql`a.created_at >= ${filter.from}::date`);
  if (filter.to) conds.push(sql`a.created_at < (${filter.to}::date + interval '1 day')`);
  return sql.join(conds, sql` AND `);
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    id: Number(r.id),
    createdAt: new Date(r.created_at as string),
    actorType: String(r.actor_type),
    actorId: (r.actor_id as string | null) ?? null,
    actorLabel: String(r.actor_label ?? ""),
    impersonatorId: (r.impersonator_id as string | null) ?? null,
    action: String(r.action),
    organizationId: (r.organization_id as string | null) ?? null,
    organizationSlug: (r.organization_slug as string | null) ?? null,
    targetType: (r.target_type as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    targetLabel: (r.target_label as string | null) ?? null,
    details: (r.details as Record<string, unknown> | null) ?? null,
    ip: (r.ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

const SELECT = sql`
  SELECT a.id, a.created_at, a.actor_type, a.actor_id, a.actor_label, a.impersonator_id, a.action,
         a.organization_id, o.slug AS organization_slug, a.target_type, a.target_id, a.target_label,
         a.details, a.ip, a.user_agent
  FROM audit_log a
  LEFT JOIN organization o ON o.id = a.organization_id`;

/** One page of entries plus the total for the filter. */
export async function queryAudit(opts: QueryOptions): Promise<{ rows: AuditRow[]; total: number }> {
  const where = whereClause(opts);
  const limit = opts.limit ?? AUDIT_PAGE_SIZE;
  const offset = opts.offset ?? (opts.filter.page - 1) * limit;
  const [list, count] = await Promise.all([
    db.execute(sql`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`),
    db.execute(sql`SELECT count(*)::int AS n FROM audit_log a WHERE ${where}`),
  ]);
  return { rows: list.rows.map((r) => toRow(r as Record<string, unknown>)), total: Number(count.rows[0]?.n ?? 0) };
}

/** Everything matching the filter, newest first, capped for the CSV export. */
export async function exportAudit(opts: QueryOptions): Promise<AuditRow[]> {
  const where = whereClause(opts);
  const { rows } = await db.execute(sql`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${AUDIT_EXPORT_MAX}`);
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/** Organizations for the filter dropdown. */
export async function auditOrganizations(): Promise<{ id: string; slug: string; name: string }[]> {
  const { rows } = await db.execute(sql`SELECT o.id, o.slug, o.name FROM organization o ORDER BY o.slug`);
  return rows.map((r) => ({ id: String(r.id), slug: String(r.slug), name: String(r.name) }));
}
