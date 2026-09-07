// Paged, searchable package lists out of an SBOM artifact. The document is
// fetched from the registry and parsed once per artifact (its digest never
// changes), then pages are cut from the cached, name-sorted list — so the
// browser never has to load a document with thousands of packages.
import { paginate, type PageState } from "@/lib/paginate-shared";
import { fetchBlobBytes } from "@/lib/registry-client";
import { extractPredicate, resolveArtifactDownload } from "@/lib/signatures";
import { sbomPackages, type SbomPackage } from "@/lib/signatures-shared";

type RepoRow = Parameters<typeof resolveArtifactDownload>[0];

const CACHE_MAX = 32;
const cache = new Map<string, SbomPackage[]>();

/**
 * The packages of the SBOM artifact `digest` in `repo`, or null when there is
 * no such document. `blob` picks one layer of the manifest: a BuildKit
 * attestation entry holds one in-toto statement per layer (SBOM, provenance).
 */
export async function loadSbomPackages(repo: RepoRow, orgSlug: string, digest: string, blob: string | null = null): Promise<SbomPackage[] | null> {
  const key = `${repo.id}:${digest}:${blob ?? ""}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const download = await resolveArtifactDownload(repo, orgSlug, digest, false, blob);
  if (!download) return null;
  const data = await fetchBlobBytes(download.repositoryPath, download.layerDigest, 64 * 1024 * 1024);
  if (!data) return null;
  // A DSSE envelope or Sigstore bundle carries the document as its predicate;
  // BuildKit's attestation layers are bare in-toto statements, so the
  // document sits under `predicate` of the JSON itself.
  const text = (download.decode ? extractPredicate(data.bytes) : null) ?? data.bytes.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc && typeof doc === "object" && "predicate" in doc && typeof (doc as { predicateType?: unknown }).predicateType === "string") {
    doc = (doc as { predicate: unknown }).predicate;
  }
  const list = sbomPackages(doc).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""));
  cache.set(key, list);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return list;
}

/** One page of the list, after a case-insensitive substring filter on name, version and license. */
export function pageSbomPackages(list: SbomPackage[], q: string, page: number, pageSize: number): { items: SbomPackage[]; state: PageState } {
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? list.filter((p) => p.name.toLowerCase().includes(needle) || (p.version ?? "").toLowerCase().includes(needle) || (p.license ?? "").toLowerCase().includes(needle))
    : list;
  const state = paginate(filtered.length, page, pageSize);
  return { items: filtered.slice(state.offset, state.offset + pageSize), state };
}
