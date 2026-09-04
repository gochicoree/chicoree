// Pure comparison logic for the tag compare page: layer, config,
// vulnerability and annotation diffs between two images. No database, no
// Node-only imports — safe for client components and the check script
// (scripts/check-compare.ts).

export interface LayerInfo {
  digest: string;
  size: number;
  mediaType?: string;
  /** Dockerfile instruction reconstructed from the image config history. */
  command: string | null;
}

/** The parts of an OCI image config the compare page looks at. */
export interface ImageConfigView {
  architecture?: string;
  os?: string;
  variant?: string;
  created?: string;
  config?: {
    Env?: string[];
    Entrypoint?: string[];
    Cmd?: string[];
    User?: string;
    WorkingDir?: string;
    ExposedPorts?: Record<string, unknown>;
    Labels?: Record<string, string>;
    Volumes?: Record<string, unknown>;
    StopSignal?: string;
  };
  history?: { created_by?: string; empty_layer?: boolean; created?: string }[];
}

/** Turn a history `created_by` into the Dockerfile instruction users recognise. */
export function cleanCommand(cmd: string | undefined | null): string | null {
  if (!cmd) return null;
  return cmd
    .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
    .replace(/^\/bin\/sh -c\s*/, "RUN ")
    .trim();
}

/**
 * Align layers with the config history: entries without `empty_layer` map
 * 1:1 onto the layers, in order (the same reconstruction the tag page uses).
 */
export function layersWithInstructions(
  layers: { digest?: string; size?: number; mediaType?: string }[],
  config: ImageConfigView | null | undefined,
): LayerInfo[] {
  const commands = (config?.history ?? []).filter((h) => !h.empty_layer).map((h) => h.created_by ?? "");
  return layers.map((l, i) => ({
    digest: l.digest ?? "",
    size: l.size ?? 0,
    mediaType: l.mediaType,
    command: cleanCommand(commands[i]),
  }));
}

export type LayerChange = "added" | "removed" | "unchanged";

export interface LayerDiffRow {
  change: LayerChange;
  layer: LayerInfo;
  /** Position in the "from" image (1-based), when present there. */
  fromIndex: number | null;
  /** Position in the "to" image (1-based), when present there. */
  toIndex: number | null;
}

export interface LayerDiff {
  rows: LayerDiffRow[];
  added: number;
  removed: number;
  unchanged: number;
  addedBytes: number;
  removedBytes: number;
}

/**
 * Layers are identified by digest. Unchanged layers appear once (in "to"
 * order); removed layers are listed where they sat in the "from" image, so
 * the reader sees the sequence of the new image with the old material
 * interleaved.
 */
export function diffLayers(from: LayerInfo[], to: LayerInfo[]): LayerDiff {
  const fromIdx = new Map<string, number>();
  from.forEach((l, i) => {
    if (!fromIdx.has(l.digest)) fromIdx.set(l.digest, i);
  });
  const toIdx = new Map<string, number>();
  to.forEach((l, i) => {
    if (!toIdx.has(l.digest)) toIdx.set(l.digest, i);
  });

  const rows: LayerDiffRow[] = [];
  let f = 0;
  let t = 0;
  // Two-pointer walk: emit removed "from" layers until the next shared one,
  // added "to" layers likewise, then the shared layer.
  while (f < from.length || t < to.length) {
    const fl = from[f];
    const tl = to[t];
    if (fl && !toIdx.has(fl.digest)) {
      rows.push({ change: "removed", layer: fl, fromIndex: f + 1, toIndex: null });
      f++;
      continue;
    }
    if (tl && !fromIdx.has(tl.digest)) {
      rows.push({ change: "added", layer: tl, fromIndex: null, toIndex: t + 1 });
      t++;
      continue;
    }
    if (fl && tl) {
      if (fl.digest === tl.digest) {
        rows.push({ change: "unchanged", layer: tl, fromIndex: f + 1, toIndex: t + 1 });
        f++;
        t++;
      } else {
        // Both shared but reordered: keep the "to" order, flush the "from"
        // side as unchanged-at-old-position so nothing is lost.
        rows.push({ change: "unchanged", layer: tl, fromIndex: (fromIdx.get(tl.digest) ?? 0) + 1, toIndex: t + 1 });
        t++;
        if (!to.slice(t).some((l) => l.digest === fl.digest)) f++;
      }
      continue;
    }
    if (fl) {
      f++;
      continue;
    }
    t++;
  }
  // Deduplicate unchanged rows a reorder may have emitted twice.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    if (r.change !== "unchanged") return true;
    if (seen.has(r.layer.digest)) return false;
    seen.add(r.layer.digest);
    return true;
  });
  const added = deduped.filter((r) => r.change === "added");
  const removed = deduped.filter((r) => r.change === "removed");
  return {
    rows: deduped,
    added: added.length,
    removed: removed.length,
    unchanged: deduped.length - added.length - removed.length,
    addedBytes: added.reduce((s, r) => s + r.layer.size, 0),
    removedBytes: removed.reduce((s, r) => s + r.layer.size, 0),
  };
}

export interface ConfigDiffRow {
  /** Section the row belongs to: env, entrypoint, cmd, user, workdir, ports, labels, volumes. */
  section: string;
  key: string;
  from: string | null;
  to: string | null;
  changed: boolean;
}

function envMap(env: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of env ?? []) {
    const i = e.indexOf("=");
    if (i < 0) m.set(e, "");
    else m.set(e.slice(0, i), e.slice(i + 1));
  }
  return m;
}

function joinArgv(v: string[] | undefined): string | null {
  if (!v || v.length === 0) return null;
  return v.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function keyedRows(section: string, a: Map<string, string>, b: Map<string, string>): ConfigDiffRow[] {
  const keys = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
  return keys.map((k) => {
    const from = a.has(k) ? a.get(k)! : null;
    const to = b.has(k) ? b.get(k)! : null;
    return { section, key: k, from, to, changed: from !== to };
  });
}

function scalarRow(section: string, key: string, from: string | null | undefined, to: string | null | undefined): ConfigDiffRow {
  const f = from || null;
  const t = to || null;
  return { section, key, from: f, to: t, changed: f !== t };
}

/** Side-by-side rows for the Config section; `changed` marks the highlighted ones. */
export function diffConfig(from: ImageConfigView | null, to: ImageConfigView | null): ConfigDiffRow[] {
  const a = from?.config ?? {};
  const b = to?.config ?? {};
  const rows: ConfigDiffRow[] = [
    scalarRow("entrypoint", "Entrypoint", joinArgv(a.Entrypoint), joinArgv(b.Entrypoint)),
    scalarRow("cmd", "Cmd", joinArgv(a.Cmd), joinArgv(b.Cmd)),
    scalarRow("user", "User", a.User, b.User),
    scalarRow("workdir", "WorkingDir", a.WorkingDir, b.WorkingDir),
    scalarRow("ports", "ExposedPorts", Object.keys(a.ExposedPorts ?? {}).sort().join(", "), Object.keys(b.ExposedPorts ?? {}).sort().join(", ")),
    scalarRow("volumes", "Volumes", Object.keys(a.Volumes ?? {}).sort().join(", "), Object.keys(b.Volumes ?? {}).sort().join(", ")),
    scalarRow("stopsignal", "StopSignal", a.StopSignal, b.StopSignal),
    scalarRow("platform", "Platform", platformOf(from), platformOf(to)),
  ];
  rows.push(...keyedRows("env", envMap(a.Env), envMap(b.Env)));
  rows.push(...keyedRows("labels", new Map(Object.entries(a.Labels ?? {})), new Map(Object.entries(b.Labels ?? {}))));
  return rows;
}

export function platformOf(c: ImageConfigView | null | undefined): string | null {
  if (!c?.os && !c?.architecture) return null;
  return `${c.os ?? "?"}/${c.architecture ?? "?"}${c.variant ? `/${c.variant}` : ""}`;
}

/** Annotations (manifest) diff: same shape as the config rows. */
export function diffAnnotations(from: Record<string, string> | undefined, to: Record<string, string> | undefined): ConfigDiffRow[] {
  return keyedRows("annotations", new Map(Object.entries(from ?? {})), new Map(Object.entries(to ?? {})));
}

/** One normalised vulnerability finding (see lib/compare.ts `findingsOf`). */
export interface Finding {
  id: string;
  name: string;
  severity: string;
  packageName: string;
  packageVersion: string;
  fixedIn: string | null;
  link: string | null;
}

export const FINDING_SEVERITIES = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"] as const;
const SEVERITY_RANK: Record<string, number> = Object.fromEntries(FINDING_SEVERITIES.map((s, i) => [s, i]));
const SEVERITY_SET = new Set<string>(FINDING_SEVERITIES);

function normalizeSeverity(v: unknown): string {
  if (typeof v !== "string" || !v) return "Unknown";
  const s = v[0].toUpperCase() + v.slice(1).toLowerCase();
  return SEVERITY_SET.has(s) ? s : "Unknown";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The Clair v4 vulnerability report shape (only what the adapter reads). */
export interface ClairReportLike {
  vulnerabilities?: Record<string, { name?: string; normalized_severity?: string; fixed_in_version?: string; links?: string }>;
  package_vulnerabilities?: Record<string, string[]>;
  packages?: Record<string, { name?: string; version?: string }>;
}

/**
 * Normalised findings of a scan row. Prefers a `findings` column (an array
 * of objects with id / name / severity / package fields, as the scanning
 * pipeline writes it — several spellings are accepted) and falls back to the
 * Clair report shape (`vulnerabilities` + `package_vulnerabilities` +
 * `packages`), so both generations of rows diff the same way. Findings are
 * deduplicated by vulnerability id + package name.
 */
export function normalizeFindings(scan: { findings?: unknown; report?: unknown } | null | undefined): Finding[] {
  if (!scan) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  const push = (f: Finding) => {
    const key = findingKey(f);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  if (Array.isArray(scan.findings)) {
    for (const raw of scan.findings as Record<string, unknown>[]) {
      if (!raw || typeof raw !== "object") continue;
      const pkg = raw.package && typeof raw.package === "object" ? (raw.package as Record<string, unknown>) : null;
      const id = str(raw.id) ?? str(raw.vulnerabilityId) ?? str(raw.vulnerability_id) ?? str(raw.name);
      if (!id) continue;
      const links = str(raw.links);
      push({
        id,
        name: str(raw.name) ?? id,
        severity: normalizeSeverity(raw.severity ?? raw.normalizedSeverity ?? raw.normalized_severity),
        packageName: str(pkg?.name) ?? str(raw.packageName) ?? str(raw.package_name) ?? (typeof raw.package === "string" ? raw.package : null) ?? "unknown",
        packageVersion: str(pkg?.version) ?? str(raw.packageVersion) ?? str(raw.package_version) ?? "",
        fixedIn: str(raw.fixedIn) ?? str(raw.fixedInVersion) ?? str(raw.fixed_in_version) ?? null,
        link: str(raw.link) ?? str(raw.url) ?? (links ? (links.split(/\s+/)[0] ?? null) : null),
      });
    }
    return out;
  }
  const report = scan.report as ClairReportLike | null | undefined;
  if (!report || typeof report !== "object") return [];
  for (const [pkgId, vulnIds] of Object.entries(report.package_vulnerabilities ?? {})) {
    const pkg = report.packages?.[pkgId];
    for (const vulnId of vulnIds ?? []) {
      const vuln = report.vulnerabilities?.[vulnId];
      if (!vuln) continue;
      push({
        id: vulnId,
        name: vuln.name || vulnId,
        severity: normalizeSeverity(vuln.normalized_severity),
        packageName: pkg?.name ?? "unknown",
        packageVersion: pkg?.version ?? "",
        fixedIn: vuln.fixed_in_version || null,
        link: vuln.links ? (vuln.links.split(/\s+/)[0] ?? null) : null,
      });
    }
  }
  return out;
}

export function findingKey(f: Finding): string {
  return `${f.id}|${f.packageName}`;
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) || a.packageName.localeCompare(b.packageName) || a.id.localeCompare(b.id),
  );
}

export interface FindingsDiff {
  /** Present in "to" only. */
  added: Finding[];
  /** Present in "from" only (fixed, or the package is gone). */
  fixed: Finding[];
  unchanged: Finding[];
  /** Per-severity counts of the added / fixed sets. */
  addedBySeverity: Record<string, number>;
  fixedBySeverity: Record<string, number>;
}

/** Findings are identified by vulnerability id + package name. */
export function diffFindings(from: Finding[], to: Finding[]): FindingsDiff {
  const a = new Map(from.map((f) => [findingKey(f), f]));
  const b = new Map(to.map((f) => [findingKey(f), f]));
  const added = sortFindings([...b.values()].filter((f) => !a.has(findingKey(f))));
  const fixed = sortFindings([...a.values()].filter((f) => !b.has(findingKey(f))));
  const unchanged = sortFindings([...b.values()].filter((f) => a.has(findingKey(f))));
  const count = (list: Finding[]) => {
    const out: Record<string, number> = {};
    for (const f of list) out[f.severity] = (out[f.severity] ?? 0) + 1;
    return out;
  };
  return { added, fixed, unchanged, addedBySeverity: count(added), fixedBySeverity: count(fixed) };
}

/** Human "+1.2 MiB" / "−3 KiB" / "±0" for a byte delta; the formatter is injected so this stays UI-free. */
export function signedDelta(delta: number, format: (n: number) => string): string {
  if (delta === 0) return "±0";
  return `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`;
}

/** Platforms two multi-arch indexes have in common, in "to" order; falls back to the union when disjoint. */
export function commonPlatforms(from: string[], to: string[]): { common: string[]; disjoint: boolean } {
  const a = new Set(from);
  const common = to.filter((p) => a.has(p));
  if (common.length > 0) return { common, disjoint: false };
  return { common: Array.from(new Set([...to, ...from])), disjoint: true };
}
