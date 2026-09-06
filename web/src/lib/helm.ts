// Reading a Helm chart archive out of the registry: gunzip the chart layer
// and walk the tar for values.yaml, Chart.yaml and the README. Bounded in
// size; nothing is cached (the tag page and the chart endpoint read on demand).
import { gunzipSync } from "node:zlib";
import { fetchBlobBytes } from "./registry-client";
import { HELM_CHART_LAYER, HELM_PROVENANCE_LAYER } from "./helm-shared";

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

export interface HelmProvenance {
  layerDigest: string;
  chartName: string | null;
  chartVersion: string | null;
  /** Files the provenance signs, name → sha256 digest. */
  files: { name: string; digest: string }[];
  /** The archive layer's digest is among the signed files. */
  matchesArchive: boolean;
  /** PGP key id from the signature packet when it can be read (long id, hex). */
  signedBy: string | null;
}

/** Parse a `helm package --sign` provenance file: a PGP clearsigned Chart.yaml plus a files map. */
export function parseHelmProvenance(text: string, archiveDigest: string | null, layerDigest: string): HelmProvenance {
  const body = text.split("-----BEGIN PGP SIGNATURE-----")[0] ?? text;
  const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(body)?.[1]?.trim() ?? null;
  const version = /^version:\s*["']?([^"'\n]+)["']?\s*$/m.exec(body)?.[1]?.trim() ?? null;
  const files: { name: string; digest: string }[] = [];
  const filesAt = body.indexOf("\nfiles:");
  if (filesAt >= 0) {
    for (const line of body.slice(filesAt + 7).split("\n")) {
      const m = /^\s+([^:]+):\s*(sha256:[0-9a-f]{64})\s*$/.exec(line);
      if (m) files.push({ name: m[1].trim(), digest: m[2] });
      else if (line.trim() && !line.startsWith(" ")) break;
    }
  }
  return {
    layerDigest,
    chartName: name,
    chartVersion: version,
    files,
    matchesArchive: !!archiveDigest && files.some((f) => f.digest === archiveDigest),
    signedBy: pgpKeyId(text),
  };
}

/** Long key id of a PGP signature block (RFC 4880 v4 signature packet, issuer subpacket 16). */
function pgpKeyId(text: string): string | null {
  const m = /-----BEGIN PGP SIGNATURE-----([\s\S]*?)-----END PGP SIGNATURE-----/.exec(text);
  if (!m) return null;
  const b64 = m[1]
    .split("\n")
    .filter((l) => l.trim() && !l.includes(":") && !l.startsWith("="))
    .join("");
  let der: Buffer;
  try {
    der = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  // Walk packet headers to the signature packet (tag 2), then its hashed/unhashed subpackets for an issuer (type 16).
  let at = 0;
  while (at < der.length) {
    const tag = der[at];
    if (!(tag & 0x80)) return null;
    let bodyStart: number;
    let bodyLen: number;
    let ptag: number;
    if (tag & 0x40) {
      ptag = tag & 0x3f;
      const l = der[at + 1];
      if (l < 192) {
        bodyLen = l;
        bodyStart = at + 2;
      } else if (l < 224) {
        bodyLen = ((l - 192) << 8) + der[at + 2] + 192;
        bodyStart = at + 3;
      } else if (l === 255) {
        bodyLen = der.readUInt32BE(at + 2);
        bodyStart = at + 6;
      } else return null;
    } else {
      ptag = (tag >> 2) & 0x0f;
      const lt = tag & 0x03;
      if (lt === 0) {
        bodyLen = der[at + 1];
        bodyStart = at + 2;
      } else if (lt === 1) {
        bodyLen = der.readUInt16BE(at + 1);
        bodyStart = at + 3;
      } else if (lt === 2) {
        bodyLen = der.readUInt32BE(at + 1);
        bodyStart = at + 5;
      } else return null;
    }
    if (ptag === 2) {
      const sig = der.subarray(bodyStart, bodyStart + bodyLen);
      if (sig[0] !== 4) return null;
      let p = 4;
      for (let area = 0; area < 2; area++) {
        const len = sig.readUInt16BE(p);
        p += 2;
        const end = p + len;
        while (p < end) {
          let sl = sig[p];
          let hdr = 1;
          if (sl >= 192 && sl < 255) {
            sl = ((sl - 192) << 8) + sig[p + 1] + 192;
            hdr = 2;
          } else if (sl === 255) {
            sl = sig.readUInt32BE(p + 1);
            hdr = 5;
          }
          const type = sig[p + hdr] & 0x7f;
          if (type === 16 && sl === 9) return sig.subarray(p + hdr + 1, p + hdr + 9).toString("hex").toUpperCase();
          p += hdr + sl;
        }
      }
      return null;
    }
    at = bodyStart + bodyLen;
  }
  return null;
}

/** The provenance layer of a chart manifest (helm push with a .prov file next to the archive), when present. */
export async function readHelmProvenance(repositoryPath: string, layers: { digest?: string; mediaType?: string }[]): Promise<HelmProvenance | null> {
  const prov = layers.find((l) => (l.mediaType ?? "").split(";")[0].trim() === HELM_PROVENANCE_LAYER);
  if (!prov?.digest) return null;
  const blob = await fetchBlobBytes(repositoryPath, prov.digest, 256 * 1024);
  if (!blob) return null;
  const archive = layers.find((l) => (l.mediaType ?? "").split(";")[0].trim() === HELM_CHART_LAYER)?.digest ?? null;
  return parseHelmProvenance(blob.bytes.toString("utf8"), archive, prov.digest);
}
