// Retention planner: pure logic shared by the settings pages (preview), the
// `retention` job and the throwaway test script. No database access here.
import { matchTagGlob, tagFlags, type TagRuleLike } from "./tag-rules-shared";

export interface RetentionSettings {
  enabled: boolean;
  /** Keep the N most recently pushed tags. */
  keepLast: number | null;
  /** Space-separated globs of tags that are always kept. */
  keepMatching: string | null;
  /** Tags last pushed more than N days ago are deletion candidates. */
  deleteOlderThanDays: number | null;
  /** Untagged manifests pushed more than N days ago are deleted. */
  deleteUntaggedAfterDays: number | null;
}

export const EMPTY_RETENTION: RetentionSettings = {
  enabled: false,
  keepLast: null,
  keepMatching: null,
  deleteOlderThanDays: null,
  deleteUntaggedAfterDays: null,
};

export interface PlanTag {
  name: string;
  digest: string;
  /** When the tag was last pushed (tags.updated_at). */
  pushedAt: Date | string;
}

export interface PlanManifest {
  digest: string;
  /** When the manifest was pushed (manifests.created_at). */
  pushedAt: Date | string;
  /** Referenced by an index (multi-arch child) that still exists. */
  isChild: boolean;
  /** Has a `subject` that still exists (a signature, SBOM, … attached to another manifest). */
  isReferrer: boolean;
  /** Other manifests point at it as their subject. */
  hasReferrers: boolean;
}

export interface PlannedTag {
  name: string;
  digest: string;
  reason: string;
}

export interface PlannedManifest {
  digest: string;
  reason: string;
}

export interface RetentionPlan {
  /** Tags to delete. */
  tags: PlannedTag[];
  /** Untagged manifests to delete. */
  manifests: PlannedManifest[];
  /** Tags that stay, and why. */
  keptTags: PlannedTag[];
  /** Untagged manifests that stay, and why. */
  keptManifests: PlannedManifest[];
}

const DAY_MS = 86_400_000;

function time(d: Date | string): number {
  return typeof d === "string" ? new Date(d).getTime() : d.getTime();
}

/** Whole days between a timestamp and now (never negative). */
export function ageDays(d: Date | string, now: Date | number = Date.now()): number {
  const nowMs = typeof now === "number" ? now : now.getTime();
  return Math.max(0, Math.floor((nowMs - time(d)) / DAY_MS));
}

export function parseKeepMatching(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does the policy define any rule that can remove a tag? */
export function hasTagRule(policy: RetentionSettings): boolean {
  return policy.keepLast != null || policy.deleteOlderThanDays != null;
}

/**
 * Decide what a policy removes right now.
 *
 * Tags: a tag is a candidate when it was pushed more than `deleteOlderThanDays`
 * ago, or — when only `keepLast` is set — always. Candidates survive when a
 * protected rule covers them, they match `keepMatching`, or they are among the
 * `keepLast` most recently pushed tags. `latest` gets no special treatment:
 * list it in keepMatching to keep it. The policy's `enabled` flag is the
 * caller's business (previews run disabled policies on purpose).
 *
 * Untagged manifests go when older than `deleteUntaggedAfterDays`, unless
 * they belong to an index, are attached to another manifest, or have
 * manifests attached to them. Manifests whose tags this plan removes are not
 * touched now; they show up as untagged on a later run.
 */
export function planRetention(input: {
  tags: PlanTag[];
  untagged: PlanManifest[];
  policy: RetentionSettings;
  rules: TagRuleLike[];
  now?: Date | number;
}): RetentionPlan {
  const { policy, rules } = input;
  const now = input.now ?? Date.now();
  const plan: RetentionPlan = { tags: [], manifests: [], keptTags: [], keptManifests: [] };

  const keepPatterns = parseKeepMatching(policy.keepMatching);
  const sorted = [...input.tags].sort((a, b) => time(b.pushedAt) - time(a.pushedAt) || a.name.localeCompare(b.name));
  const recent = new Set(policy.keepLast != null ? sorted.slice(0, policy.keepLast).map((t) => t.name) : []);
  const tagRules = hasTagRule(policy);

  for (const t of sorted) {
    const entry = (reason: string) => ({ name: t.name, digest: t.digest, reason });
    const flags = tagFlags(rules, t.name);
    if (flags.protected) {
      plan.keptTags.push(entry(`protected by rule "${flags.protected.pattern}"`));
      continue;
    }
    const keep = keepPatterns.find((p) => matchTagGlob(p, t.name));
    if (keep) {
      plan.keptTags.push(entry(`matches keep pattern "${keep}"`));
      continue;
    }
    if (!tagRules) {
      plan.keptTags.push(entry("the policy has no tag rule"));
      continue;
    }
    if (recent.has(t.name)) {
      plan.keptTags.push(entry(`among the ${policy.keepLast} most recently pushed`));
      continue;
    }
    const age = ageDays(t.pushedAt, now);
    if (policy.deleteOlderThanDays != null) {
      if (age > policy.deleteOlderThanDays) {
        plan.tags.push(
          entry(
            policy.keepLast != null
              ? `pushed ${age} days ago (older than ${policy.deleteOlderThanDays}) and not among the ${policy.keepLast} most recent`
              : `pushed ${age} days ago (older than ${policy.deleteOlderThanDays})`,
          ),
        );
      } else {
        plan.keptTags.push(entry(`pushed ${age} days ago (within ${policy.deleteOlderThanDays} days)`));
      }
      continue;
    }
    plan.tags.push(entry(`not among the ${policy.keepLast} most recently pushed`));
  }

  for (const m of input.untagged) {
    const entry = (reason: string) => ({ digest: m.digest, reason });
    if (policy.deleteUntaggedAfterDays == null) {
      plan.keptManifests.push(entry("the policy has no untagged rule"));
      continue;
    }
    if (m.isChild) {
      plan.keptManifests.push(entry("part of a multi-arch index"));
      continue;
    }
    if (m.isReferrer) {
      plan.keptManifests.push(entry("attached to another manifest (referrer)"));
      continue;
    }
    if (m.hasReferrers) {
      plan.keptManifests.push(entry("other manifests are attached to it"));
      continue;
    }
    const age = ageDays(m.pushedAt, now);
    if (age > policy.deleteUntaggedAfterDays) {
      plan.manifests.push(entry(`untagged, pushed ${age} days ago (older than ${policy.deleteUntaggedAfterDays})`));
    } else {
      plan.keptManifests.push(entry(`untagged, pushed ${age} days ago (within ${policy.deleteUntaggedAfterDays} days)`));
    }
  }

  return plan;
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** One-line summary of a policy for headers and inherited-policy hints. */
export function describeRetention(policy: RetentionSettings | null | undefined): string {
  if (!policy || !policy.enabled) return "off";
  const parts: string[] = [];
  if (policy.keepLast != null) parts.push(`keep the ${policy.keepLast} newest tags`);
  const keep = parseKeepMatching(policy.keepMatching);
  if (keep.length) parts.push(`always keep ${keep.join(" ")}`);
  if (policy.deleteOlderThanDays != null) parts.push(`delete tags older than ${days(policy.deleteOlderThanDays)}`);
  if (policy.deleteUntaggedAfterDays != null) parts.push(`delete untagged manifests after ${days(policy.deleteUntaggedAfterDays)}`);
  return parts.length ? parts.join(", ") : "enabled, but no rule set";
}

/** Read a positive integer form field; empty = null; anything else = error. */
export function parseDaysField(raw: string, label: string): { value: number | null } | { error: string } {
  const s = raw.trim();
  if (!s) return { value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return { error: `${label} must be a whole number of at least 1.` };
  return { value: n };
}
