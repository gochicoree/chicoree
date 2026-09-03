// Tag-rule logic that is safe to ship to the browser (no database access):
// glob matching, pattern validation and the per-tag immutable/protected
// lookup behind the lock badges. registryd has the same matcher in
// internal/store/tagrules.go; keep the two in step.

export interface TagRuleLike {
  pattern: string;
  immutable: boolean;
  protected: boolean;
  /** null = organization-wide rule. */
  repositoryId?: string | null;
}

/**
 * Match a tag against a rule pattern: `*` is any run of characters
 * (including none), `?` exactly one, everything else literal. Case-sensitive.
 */
export function matchTagGlob(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      // Try the rest with zero characters first; backtrack one at a time.
      starP = p;
      starN = n;
      p++;
    } else if (starP >= 0) {
      p = starP + 1;
      starN++;
      n = starN;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

const PATTERN_RE = /^[A-Za-z0-9_.*?-]{1,128}$/;

/** Validation message for a rule pattern, or null when it is fine. */
export function validateTagPattern(pattern: string): string | null {
  if (!pattern) return "Enter a tag pattern.";
  if (!PATTERN_RE.test(pattern)) return "Patterns use tag characters (letters, digits, . _ -) plus * and ?.";
  return null;
}

export interface TagFlags<R extends TagRuleLike = TagRuleLike> {
  /** The first immutable rule covering the tag, if any. */
  immutable: R | null;
  /** The first protected rule covering the tag, if any. */
  protected: R | null;
}

/** Which rules lock a tag. Pass repository rules before organization rules. */
export function tagFlags<R extends TagRuleLike>(rules: R[], tag: string): TagFlags<R> {
  let immutable: R | null = null;
  let prot: R | null = null;
  for (const r of rules) {
    if ((immutable || !r.immutable) && (prot || !r.protected)) continue;
    if (!matchTagGlob(r.pattern, tag)) continue;
    if (r.immutable && !immutable) immutable = r;
    if (r.protected && !prot) prot = r;
  }
  return { immutable, protected: prot };
}

/** Short human label for what a rule does. */
export function describeTagRule(rule: TagRuleLike): string {
  const parts: string[] = [];
  if (rule.immutable) parts.push("immutable");
  if (rule.protected) parts.push("protected");
  return parts.join(" + ") || "no effect";
}
