// Pull rate limit syntax shared by the admin form (client) and the server
// action. Pure functions only — no database, no Node APIs. registryd
// implements the same grammar in internal/ratelimit (ParseLimit / ParseCIDRs).

export interface RateLimit {
  count: number;
  windowSeconds: number;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const LIMIT_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*([smhd])\s*$/;

/**
 * Parse "<count>/<window>" (e.g. "100/6h", "3/1m"). An empty string means
 * unlimited and yields { limit: null } without an error.
 */
export function parseRateLimit(text: string): { limit: RateLimit | null; error?: string } {
  if (text.trim() === "") return { limit: null };
  const m = LIMIT_RE.exec(text);
  if (!m) return { limit: null, error: `"${text.trim()}" is not a limit; use <count>/<window> such as 100/6h` };
  const count = Number(m[1]);
  const n = Number(m[2]);
  if (!Number.isSafeInteger(count) || count <= 0) return { limit: null, error: "The count must be a positive whole number." };
  if (n <= 0) return { limit: null, error: "The window must be positive." };
  return { limit: { count, windowSeconds: n * UNIT_SECONDS[m[3]] } };
}

/** "21600" seconds → "6h"; picks the largest unit that divides evenly. */
export function formatWindow(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

const UNIT_WORDS: [number, string][] = [
  [86400, "day"],
  [3600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/** Human sentence for a limit: "100 pulls per 6 hours"; "unlimited" for none. */
export function describeRateLimit(limit: RateLimit | null, noun = "pulls"): string {
  if (!limit) return "unlimited";
  const [size, word] = UNIT_WORDS.find(([s]) => limit.windowSeconds % s === 0) ?? [1, "second"];
  const n = limit.windowSeconds / size;
  const unit = n === 1 ? word : `${word}s`;
  const singular = noun.replace(/s$/, "");
  return `${limit.count} ${limit.count === 1 ? singular : noun} per ${n === 1 ? "" : `${n} `}${unit}`;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:.]+$/i;

function isAddress(s: string): boolean {
  if (IPV4_RE.test(s)) return true;
  // Loose IPv6 check: hex groups with at least one colon, at most one "::".
  return IPV6_RE.test(s) && s.includes(":") && s.split("::").length <= 2;
}

/**
 * Split a comma/whitespace/newline separated list of CIDRs or addresses
 * and validate each entry's shape (registryd does the strict parse).
 */
export function parseTrustedProxies(text: string): { entries: string[]; error?: string } {
  const entries = text.split(/[\s,;]+/).filter(Boolean);
  for (const e of entries) {
    const [addr, prefix, ...rest] = e.split("/");
    if (rest.length > 0 || !isAddress(addr)) return { entries, error: `"${e}" is not a CIDR or IP address.` };
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = addr.includes(":") ? 128 : 32;
      if (!/^\d+$/.test(prefix) || bits > max) return { entries, error: `"${e}" has an invalid prefix length.` };
    }
  }
  return { entries };
}
