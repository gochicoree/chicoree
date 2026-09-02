// Pull-policy rules that are safe to ship to the browser (no database
// access): types, the effective-policy merge and the violation check.
import type { SeveritySummary } from "@/components/severity";

export type Level = "critical" | "high" | "medium" | "low";
export const LEVELS: Level[] = ["critical", "high", "medium", "low"];

export interface Policy {
  /** Block at this severity and above; null = never block. */
  level: Level | null;
  /** Count findings without a rating as violations. */
  unrated: boolean;
}

interface OrgPolicyRow {
  blockPullsAt: Level | null;
  blockUnrated: boolean;
}
interface RepoPolicyRow {
  blockPullsAt: "off" | Level | null;
  blockUnrated: boolean | null;
}

const COVERS: Record<Level, (keyof SeveritySummary)[]> = {
  critical: ["Critical"],
  high: ["Critical", "High"],
  medium: ["Critical", "High", "Medium"],
  low: ["Critical", "High", "Medium", "Low"],
};

export function orgPolicy(org: OrgPolicyRow | null | undefined): Policy {
  return { level: org?.blockPullsAt ?? null, unrated: org?.blockUnrated ?? false };
}

/** The policy that applies to a repository once its override is folded in. */
export function effectivePolicy(org: OrgPolicyRow | null | undefined, repo: RepoPolicyRow): Policy {
  if (repo.blockPullsAt === "off") return { level: null, unrated: false };
  if (repo.blockPullsAt) return { level: repo.blockPullsAt, unrated: repo.blockUnrated ?? org?.blockUnrated ?? false };
  return orgPolicy(org);
}

export function describePolicy(policy: Policy): string {
  if (!policy.level) return "off";
  const base = policy.level === "critical" ? "critical findings" : `${policy.level} and above`;
  return policy.unrated ? `${base}, unrated too` : base;
}

/** Why a scanned image violates the policy, or null when it passes. */
export function violation(summary: SeveritySummary | null | undefined, policy: Policy): string | null {
  if (!policy.level || !summary) return null;
  const parts: string[] = [];
  for (const key of COVERS[policy.level]) {
    const n = summary[key] ?? 0;
    if (n > 0) parts.push(`${n} ${key.toLowerCase()}`);
  }
  if (policy.unrated && (summary.Unknown ?? 0) > 0) parts.push(`${summary.Unknown} unrated`);
  if (parts.length === 0) return null;
  return `${parts.join(", ")} finding${parts.length === 1 && /^1 /.test(parts[0]) ? "" : "s"}; policy blocks ${describePolicy(policy)}`;
}
