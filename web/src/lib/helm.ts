// Reading a Helm chart archive out of the registry: gunzip the chart layer
// and walk the tar for values.yaml, Chart.yaml and the README. Bounded in
// size; nothing is cached (the tag page and the chart endpoint read on demand).
import { gunzipSync } from "node:zlib";
import { fetchBlobBytes } from "./registry-client";
import { HELM_CHART_LAYER } from "./helm-shared";

export interface ChartFiles {
  /** values.yaml, trimmed to VALUES_MAX characters. */
  values: string | null;
  readme: string | null;
  chartYaml: string | null;
  /** Paths inside the archive (without the top-level chart directory). */
  files: string[];
  truncated: boolean;
}

const ARCHIVE_MAX = 8 * 1024 * 1024;
const VALUES_MAX = 64 * 1024;
const README_MAX = 128 * 1024;

interface TarEntry {
  name: string;
  size: number;
  offset: number;
}

/** Minimal ustar/pax reader: names, sizes and offsets of regular files. */
export function tarEntries(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let paxPath: string | null = null;
  let longName: string | null = null;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8) || 0;
    const type = field(156, 1);
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = at + 512;
    if (type === "x") {
      // pax extended header: path=… records override the next entry's name
      const rec = tar.subarray(dataStart, dataStart + size).toString("utf8");
      for (const line of rec.split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m) paxPath = m[1];
      }
    } else if (type === "L") {
      longName = tar.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "0" || type === "") {
      out.push({ name: paxPath ?? longName ?? name, size, offset: dataStart });
      paxPath = null;
      longName = null;
    } else {
      paxPath = null;
      longName = null;
    }
    at = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The chart archive's interesting files; null when the layer cannot be read. */
export async function readChartFiles(repositoryPath: string, layers: { digest?: string; mediaType?: string }[]): Promise<ChartFiles | null> {
  const layer = layers.find((l) => (l.mediaType ?? "").split(";")[0].trim() === HELM_CHART_LAYER) ?? layers[0];
  if (!layer?.digest) return null;
  const blob = await fetchBlobBytes(repositoryPath, layer.digest, ARCHIVE_MAX);
  if (!blob) return null;
  let tar: Buffer;
  try {
    tar = gunzipSync(blob.bytes);
  } catch {
    return null;
  }
  const entries = tarEntries(tar);
  // helm package puts everything under <chart>/; strip that first segment.
  const strip = (n: string) => n.replace(/^\.\//, "").replace(/^[^/]+\//, "");
  const text = (e: TarEntry | undefined, max: number): { value: string | null; truncated: boolean } => {
    if (!e) return { value: null, truncated: false };
    const raw = tar.subarray(e.offset, e.offset + Math.min(e.size, max)).toString("utf8");
    return { value: raw, truncated: e.size > max };
  };
  const byName = (n: string) => entries.find((e) => strip(e.name).toLowerCase() === n.toLowerCase());
  const values = text(byName("values.yaml") ?? byName("values.yml"), VALUES_MAX);
  const readme = text(byName("README.md") ?? byName("README.markdown") ?? byName("README"), README_MAX);
  const chartYaml = text(byName("Chart.yaml"), VALUES_MAX);
  return {
    values: values.value,
    readme: readme.value,
    chartYaml: chartYaml.value,
    files: entries.map((e) => strip(e.name)).filter((n) => n && !n.endsWith("/")).sort(),
    truncated: values.truncated || readme.truncated,
  };
}
