// JSON shapes and body parsing for the limits and usage endpoints. The
// catalog examples (lib/api/catalog.ts) are the contract; keep the field
// names here in step with them.
import { forbidden, nullableIntField, stringField, unprocessable } from "./respond";
import { iso } from "./respond";
import type { ApiCaller } from "./auth";
import { getOrgLimitsRow, getUserLimitsRow, type LimitsRow, type OrgLimitsValues, type UserLimitsValues } from "@/lib/limits";
import { getOrgLimits, getOrgUsage, getUserLimits, getUserUsage, UNLIMITED, type Limits, type Usage } from "@/lib/quota";
import { orgTraffic, ownedOrgsTraffic, parseMonth, type MonthlyTraffic } from "@/lib/traffic";

const pct = (used: number, max: number | null) => (max === null || max === 0 ? null : Math.round((used / max) * 1000) / 10);

export function orgLimitsJson(slug: string, row: LimitsRow<OrgLimitsValues> | null) {
  return {
    organization: slug,
    configured: row !== null,
    limits: {
      maxPublicRepositories: row?.maxPublicRepos ?? null,
      maxPrivateRepositories: row?.maxPrivateRepos ?? null,
      maxStorageBytes: row?.maxStorageBytes ?? null,
      maxMembers: row?.maxMembers ?? null,
    },
    label: row?.label ?? "",
    note: row?.note ?? "",
    updatedAt: iso(row?.updatedAt),
    updatedBy: row?.updatedBy ?? null,
  };
}

export function userLimitsJson(userId: string, row: LimitsRow<UserLimitsValues> | null) {
  return {
    user: userId,
    configured: row !== null,
    limits: {
      maxOrganizations: row?.maxOrganizations ?? null,
      maxPublicRepositories: row?.maxPublicRepos ?? null,
      maxPrivateRepositories: row?.maxPrivateRepos ?? null,
      maxStorageBytes: row?.maxStorageBytes ?? null,
    },
    label: row?.label ?? "",
    note: row?.note ?? "",
    updatedAt: iso(row?.updatedAt),
    updatedBy: row?.updatedBy ?? null,
  };
}

/**
 * PATCH body → the next row. Omitted fields keep the stored value (or
 * unlimited / empty when there is no row yet); null means unlimited.
 */
export function mergeOrgLimitsBody(body: Record<string, unknown>, current: LimitsRow<OrgLimitsValues> | null): OrgLimitsValues {
  const base: OrgLimitsValues = current ?? { maxPublicRepos: null, maxPrivateRepos: null, maxStorageBytes: null, maxMembers: null, label: "", note: "" };
  const pub = nullableIntField(body, "maxPublicRepositories");
  const priv = nullableIntField(body, "maxPrivateRepositories");
  const storage = nullableIntField(body, "maxStorageBytes");
  const members = nullableIntField(body, "maxMembers", { min: 1 });
  const label = stringField(body, "label", 80);
  const note = stringField(body, "note", 1000);
  return {
    maxPublicRepos: pub === undefined ? base.maxPublicRepos : pub,
    maxPrivateRepos: priv === undefined ? base.maxPrivateRepos : priv,
    maxStorageBytes: storage === undefined ? base.maxStorageBytes : storage,
    maxMembers: members === undefined ? base.maxMembers : members,
    label: label === undefined ? base.label : label,
    note: note === undefined ? base.note : note,
  };
}

export function mergeUserLimitsBody(body: Record<string, unknown>, current: LimitsRow<UserLimitsValues> | null): UserLimitsValues {
  const base: UserLimitsValues = current ?? { maxOrganizations: null, maxPublicRepos: null, maxPrivateRepos: null, maxStorageBytes: null, label: "", note: "" };
  const orgs = nullableIntField(body, "maxOrganizations");
  const pub = nullableIntField(body, "maxPublicRepositories");
  const priv = nullableIntField(body, "maxPrivateRepositories");
  const storage = nullableIntField(body, "maxStorageBytes");
  const label = stringField(body, "label", 80);
  const note = stringField(body, "note", 1000);
  return {
    maxOrganizations: orgs === undefined ? base.maxOrganizations : orgs,
    maxPublicRepos: pub === undefined ? base.maxPublicRepos : pub,
    maxPrivateRepos: priv === undefined ? base.maxPrivateRepos : priv,
    maxStorageBytes: storage === undefined ? base.maxStorageBytes : storage,
    label: label === undefined ? base.label : label,
    note: note === undefined ? base.note : note,
  };
}

/** `?month=YYYY-MM` or the current month; a malformed value is a 422. */
export function monthParam(url: URL): string {
  const m = parseMonth(url.searchParams.get("month"));
  if (m.month === undefined) throw unprocessable(m.error, { field: "month" });
  return m.month;
}

function usageBlock(usage: Usage, limits: Limits, traffic: MonthlyTraffic, label: string, withOrganizations: boolean) {
  return {
    usage: {
      ...(withOrganizations ? { organizations: usage.organizations } : {}),
      publicRepositories: usage.publicRepos,
      privateRepositories: usage.privateRepos,
      storageBytes: usage.storageBytes,
      members: usage.members,
    },
    limits: {
      ...(withOrganizations ? { maxOrganizations: limits.maxOrganizations } : {}),
      maxPublicRepositories: limits.maxPublicRepos,
      maxPrivateRepositories: limits.maxPrivateRepos,
      maxStorageBytes: limits.maxStorageBytes,
      ...(withOrganizations ? {} : { maxMembers: limits.maxMembers }),
    },
    percent: {
      ...(withOrganizations ? { organizations: pct(usage.organizations, limits.maxOrganizations) } : {}),
      publicRepositories: pct(usage.publicRepos, limits.maxPublicRepos),
      privateRepositories: pct(usage.privateRepos, limits.maxPrivateRepos),
      storage: pct(usage.storageBytes, limits.maxStorageBytes),
      ...(withOrganizations ? {} : { members: pct(usage.members, limits.maxMembers) }),
    },
    label,
    traffic,
  };
}

/** Usage of one organization against its own limits, with the month's traffic. */
export async function orgUsageJson(org: { id: string; slug: string }, month: string) {
  const [usage, limits, row, traffic] = await Promise.all([getOrgUsage(org.id), getOrgLimits(org.id), getOrgLimitsRow(org.id), orgTraffic(org.id, month)]);
  return { organization: org.slug, ...usageBlock(usage, limits, traffic, row?.label ?? "", false) };
}

/** Usage across every organization the user owns against the account limits. */
export async function userUsageJson(userId: string, month: string) {
  const [usage, limits, row, traffic] = await Promise.all([getUserUsage(userId), getUserLimits(userId), getUserLimitsRow(userId), ownedOrgsTraffic(userId, month)]);
  return { user: userId, ...usageBlock(usage, limits ?? UNLIMITED, traffic, row?.label ?? "", true) };
}

/** The caller as a user (tokens and sessions), refusing service accounts and CI credentials. */
export function requireUserCaller(c: ApiCaller, what: string) {
  if (c.kind !== "user") throw forbidden(`Only users can ${what}.`);
  return c;
}
