// Mirror / import engine: pull selected tags from another registry into a
// local repository, relabelling them on the way. Content flows source →
// this process → registryd (as a normal authenticated client), so quotas and
// dedup apply exactly as for a docker push.
import http from "http";
import https from "https";
import { Readable } from "stream";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  mirrorRuns,
  mirrors,
  organization,
  repositories,
  tags as tagsTable,
  type MirrorLogEntry,
  type Relabel,
  type TagSelector,
} from "@/db/schema";
import { decryptSecret } from "./crypto";
import { env } from "./env";
import { imagePath } from "./library";
import { signRegistryToken } from "./registry-jwt";
import { parseSource, RemoteRegistry } from "./remote-registry";
import { notify } from "./notify";
import { emitRepositoryEvent } from "./webhooks";

// --- Tag selection ---------------------------------------------------------

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matcher(mode: TagSelector["mode"], pattern: string): (tag: string) => boolean {
  const p = pattern.trim();
  switch (mode) {
    case "all":
      return () => true;
    case "glob": {
      const res = p.split(/[\s,]+/).filter(Boolean).map(globToRegex);
      return (t) => res.some((r) => r.test(t));
    }
    case "regex": {
      const re = new RegExp(p);
      return (t) => re.test(t);
    }
    case "list": {
      const set = new Set(p.split(/[\s,]+/).filter(Boolean));
      return (t) => set.has(t);
    }
  }
}

/** Apply the selector (and exclude glob/regex) to a tag list. */
export function selectTags(tags: string[], selector: TagSelector): string[] {
  const include = matcher(selector.mode, selector.pattern);
  const exclude = selector.exclude?.trim()
    ? selector.mode === "regex"
      ? matcher("regex", selector.exclude)
      : matcher("glob", selector.exclude)
    : () => false;
  return tags.filter((t) => include(t) && !exclude(t)).sort();
}

// --- Relabelling -----------------------------------------------------------

/** Rewrite a source tag into the destination tag. */
export function relabelTag(sourceTag: string, relabel: Relabel, sourceRepo: string): string {
  let tag = sourceTag;
  if (relabel.replaceFrom) {
    try {
      tag = tag.replace(new RegExp(relabel.replaceFrom, "g"), relabel.replaceTo ?? "");
    } catch {
      /* invalid regex: leave the tag as is */
    }
  }
  const semver = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag);
  const vars: Record<string, string> = {
    tag,
    source: sourceRepo.split("/").pop() ?? sourceRepo,
    major: semver?.[1] ?? "",
    minor: semver?.[2] ?? "",
    patch: semver?.[3] ?? "",
  };
  const out = (relabel.tagTemplate || "{tag}").replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  return out.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 128) || tag;
}

// --- Local registry client (push side) --------------------------------------

class LocalPusher {
  constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  private url(p: string) {
    return `${env.registryInternalUrl}/v2/${this.path}${p}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async hasBlob(digest: string): Promise<boolean> {
    const res = await fetch(this.url(`/blobs/${digest}`), { method: "HEAD", headers: this.headers() });
    return res.status === 200;
  }

  async hasManifest(digest: string): Promise<boolean> {
    const res = await fetch(this.url(`/manifests/${digest}`), {
      method: "HEAD",
      headers: this.headers({ Accept: "*/*" }),
    });
    return res.status === 200;
  }

  async currentTagDigest(tag: string): Promise<string | null> {
    const res = await fetch(this.url(`/manifests/${tag}`), { method: "HEAD", headers: this.headers({ Accept: "*/*" }) });
    return res.status === 200 ? res.headers.get("docker-content-digest") : null;
  }

  /**
   * Stream a remote blob into the registry. Uses Node's core HTTP client
   * rather than fetch: piping a fetch response body into a fetch request body
   * is fragile under undici, while a Readable → http.request pipe is not.
   */
  async putBlob(digest: string, stream: ReadableStream<Uint8Array>, size: number | null): Promise<void> {
    const start = await fetch(this.url("/blobs/uploads/"), { method: "POST", headers: this.headers() });
    if (start.status !== 202) throw new Error(`upload start: ${await describe(start)}`);
    const location = start.headers.get("location");
    if (!location) throw new Error("upload start returned no Location");
    const target = new URL(location, env.registryInternalUrl);
    target.searchParams.set("digest", digest);

    const body = Readable.fromWeb(stream as import("stream/web").ReadableStream<Uint8Array>);
    const status = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      const client = target.protocol === "https:" ? https : http;
      const req = client.request(
        target,
        {
          method: "PUT",
          headers: {
            ...this.headers({ "Content-Type": "application/octet-stream" }),
            ...(size !== null ? { "Content-Length": String(size) } : { "Transfer-Encoding": "chunked" }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c.length < 2000 ? c : ""));
          res.on("end", () => resolve({ code: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      body.on("error", (err) => {
        req.destroy(err);
        reject(err);
      });
      body.pipe(req);
    });
    if (status.code !== 201) {
      let message = `HTTP ${status.code}`;
      try {
        const parsed = JSON.parse(status.text) as { errors?: { message?: string }[] };
        if (parsed.errors?.[0]?.message) message += `: ${parsed.errors[0].message}`;
      } catch {
        if (status.text) message += `: ${status.text.slice(0, 200)}`;
      }
      throw new Error(`blob ${digest}: ${message}`);
    }
  }

  async getManifest(reference: string): Promise<{ bytes: Buffer; mediaType: string }> {
    const res = await fetch(this.url(`/manifests/${reference}`), { headers: this.headers({ Accept: "*/*" }) });
    if (res.status !== 200) throw new Error(`manifest ${reference}: ${await describe(res)}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mediaType: res.headers.get("content-type") ?? "application/vnd.oci.image.manifest.v1+json",
    };
  }

  async getBlobJson(digest: string): Promise<unknown> {
    const res = await fetch(this.url(`/blobs/${digest}`), { headers: this.headers() });
    if (res.status !== 200) throw new Error(`blob ${digest}: ${await describe(res)}`);
    return res.json();
  }

  async putManifest(reference: string, bytes: Buffer, mediaType: string): Promise<void> {
    const res = await fetch(this.url(`/manifests/${reference}`), {
      method: "PUT",
      headers: this.headers({ "Content-Type": mediaType }),
      body: new Uint8Array(bytes),
    });
    if (res.status !== 201) throw new Error(`manifest ${reference}: ${await describe(res)}`);
  }
}

async function describe(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { errors?: { message?: string }[] };
    if (parsed.errors?.[0]?.message) return `HTTP ${res.status}: ${parsed.errors[0].message}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${text ? `: ${text}` : ""}`;
}

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

// --- The run ---------------------------------------------------------------

export async function runMirror(mirrorId: string): Promise<{ runId: string; status: string }> {
  const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.id, mirrorId) });
  if (!mirror) throw new Error("mirror not found");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, mirror.repositoryId) });
  if (!repo) throw new Error("target repository not found");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) throw new Error("organization not found");

  const [run] = await db.insert(mirrorRuns).values({ mirrorId, status: "running" }).returning({ id: mirrorRuns.id });
  const log: MirrorLogEntry[] = [];
  let matched = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const source = parseSource(mirror.source);
    const authRaw = decryptSecret(mirror.sourceAuth);
    const auth = authRaw ? { username: authRaw.split(":")[0], password: authRaw.slice(authRaw.indexOf(":") + 1) } : null;
    const remote = new RemoteRegistry(source, auth);

    const targetPath = imagePath(org.slug, repo.name);
    const { token } = await signRegistryToken(
      `mirror:${mirror.id}`,
      [{ type: "repository", name: targetPath, actions: ["pull", "push"] }],
      4 * 3600,
    );
    const local = new LocalPusher(targetPath, token);

    const allTags = await remote.listTags();
    const selected = selectTags(allTags, mirror.selector);
    matched = selected.length;

    for (const sourceTag of selected) {
      const targetTag = relabelTag(sourceTag, mirror.relabel, source.repository);
      try {
        const manifest = await remote.getManifest(sourceTag);
        const current = await local.currentTagDigest(targetTag);
        if (current === manifest.digest) {
          skipped++;
          log.push({ sourceTag, targetTag, digest: manifest.digest, status: "skipped", detail: "already up to date" });
          continue;
        }
        if (current && !mirror.overwrite) {
          skipped++;
          log.push({ sourceTag, targetTag, digest: manifest.digest, status: "skipped", detail: "exists; overwrite disabled" });
          continue;
        }
        try {
          await importManifest(remote, local, manifest.bytes, manifest.mediaType, manifest.digest, targetTag);
        } catch (first) {
          // Blobs already copied are skipped on the second pass, so a retry
          // only redoes what actually failed.
          console.warn(`mirror ${mirror.id}: retrying ${sourceTag} after ${describeError(first)}`);
          await importManifest(remote, local, manifest.bytes, manifest.mediaType, manifest.digest, targetTag);
        }
        imported++;
        log.push({ sourceTag, targetTag, digest: manifest.digest, status: "imported" });
      } catch (err) {
        failed++;
        log.push({ sourceTag, targetTag, status: "failed", detail: describeError(err) });
      }
      // Persist progress so long runs are observable.
      await db.update(mirrorRuns).set({ matched, imported, skipped, failed, log }).where(eq(mirrorRuns.id, run.id));
    }

    // Registries only have a "latest" tag if someone pushed one. When the
    // source has none, point ours at the newest imported image so plain
    // `docker pull` works on the mirror.
    if (mirror.relabel.latest !== false && !allTags.includes("latest") && !log.some((e) => e.targetTag === "latest")) {
      const entry = await publishLatest(local, log);
      if (entry) log.push(entry);
    }

    const status = failed > 0 && imported === 0 && skipped === 0 ? "failed" : "succeeded";
    await db
      .update(mirrorRuns)
      .set({ status, matched, imported, skipped, failed, log, finishedAt: new Date() })
      .where(eq(mirrorRuns.id, run.id));
    await db
      .update(mirrors)
      .set({ lastRunAt: new Date(), lastStatus: status, lastError: failed > 0 ? `${failed} tag(s) failed` : null })
      .where(eq(mirrors.id, mirrorId));
    await announceMirrorRun(mirror, repo.id, run.id, status, {
      matched,
      imported,
      skipped,
      failed,
      error: failed > 0 ? `${failed} tag(s) failed` : null,
    });
    return { runId: run.id, status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(mirrorRuns)
      .set({ status: "failed", matched, imported, skipped, failed, log, error: message, finishedAt: new Date() })
      .where(eq(mirrorRuns.id, run.id));
    await db.update(mirrors).set({ lastRunAt: new Date(), lastStatus: "failed", lastError: message }).where(eq(mirrors.id, mirrorId));
    await announceMirrorRun(mirror, repo.id, run.id, "failed", { matched, imported, skipped, failed, error: message });
    return { runId: run.id, status: "failed" };
  }
}

/** Failed runs notify the organization (mirror.failed); finished ones reach webhooks (mirror.completed). */
async function announceMirrorRun(
  mirror: { id: string; source: string },
  repositoryId: string,
  runId: string,
  status: "succeeded" | "failed",
  stats: { matched: number; imported: number; skipped: number; failed: number; error: string | null },
): Promise<void> {
  try {
    if (status === "failed") {
      await notify({ event: "mirror.failed", mirrorId: mirror.id, repositoryId, runId, error: stats.error ?? "mirror failed" });
    } else {
      await emitRepositoryEvent(repositoryId, "mirror.completed", {
        mirror: { id: mirror.id, source: mirror.source },
        run: { id: runId, status, ...stats },
      });
    }
  } catch (err) {
    console.error("mirror notification failed:", err);
  }
}

/** Copy one manifest (recursively for indexes) and everything it references. */
async function importManifest(
  remote: RemoteRegistry,
  local: LocalPusher,
  bytes: Buffer,
  mediaType: string,
  digest: string,
  tag: string | null,
): Promise<void> {
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    config?: Descriptor;
    layers?: Descriptor[];
    manifests?: Descriptor[];
  };

  if (Array.isArray(parsed.manifests)) {
    for (const child of parsed.manifests) {
      if (!child.digest) continue;
      if (await local.hasManifest(child.digest)) continue;
      const childManifest = await remote.getManifest(child.digest);
      await importManifest(remote, local, childManifest.bytes, childManifest.mediaType, childManifest.digest, null);
    }
  } else {
    const blobs = [parsed.config, ...(parsed.layers ?? [])].filter((d): d is Descriptor => !!d?.digest);
    for (const blob of blobs) {
      if (blob.mediaType && /foreign|nondistributable/.test(blob.mediaType)) continue;
      if (await local.hasBlob(blob.digest!)) continue;
      const { stream, size } = await remote.openBlob(blob.digest!);
      await local.putBlob(blob.digest!, stream, size ?? blob.size ?? null);
    }
  }
  await local.putManifest(tag ?? digest, bytes, mediaType);
}

/**
 * Tags that look like versions: v1.2.3, 1.27, 2. The fourth element ranks a
 * plain release (1) above anything with a suffix such as -rc1 or -alpine (0).
 */
export function versionKey(tag: string): [number, number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?=([-+.])|$)/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ? 0 : 1];
}

/**
 * Pick the newest of this run's images: the highest version tag when any
 * parse as versions, otherwise the most recently built image (config
 * "created"); ties and undated images fall back to import order.
 */
export async function pickNewest<T extends { targetTag: string; digest: string }>(
  candidates: T[],
  createdAt: (digest: string) => Promise<Date | null>,
): Promise<T | null> {
  if (candidates.length === 0) return null;
  const versioned = candidates
    .map((c) => ({ c, key: versionKey(c.targetTag) }))
    .filter((x): x is { c: T; key: [number, number, number, number] } => x.key !== null);
  if (versioned.length > 0) {
    const cmp = (a: number[], b: number[]) => a.map((v, i) => v - b[i]).find((d) => d !== 0) ?? 0;
    let best = versioned[0];
    for (const x of versioned) if (cmp(x.key, best.key) >= 0) best = x;
    return best.c;
  }
  let best: { c: T; at: number } | null = null;
  for (const c of candidates.slice(-100)) {
    const at = (await createdAt(c.digest).catch(() => null))?.getTime() ?? 0;
    if (!best || at >= best.at) best = { c, at };
  }
  return best?.c ?? candidates[candidates.length - 1];
}

/** Build date of an image from its config blob (first child for indexes). */
async function imageCreatedAt(local: LocalPusher, digest: string): Promise<Date | null> {
  let manifest = JSON.parse((await local.getManifest(digest)).bytes.toString("utf8")) as {
    config?: Descriptor;
    manifests?: Descriptor[];
  };
  if (Array.isArray(manifest.manifests)) {
    const child = manifest.manifests.find((m) => m.digest);
    if (!child?.digest) return null;
    manifest = JSON.parse((await local.getManifest(child.digest)).bytes.toString("utf8"));
  }
  if (!manifest.config?.digest) return null;
  const config = (await local.getBlobJson(manifest.config.digest)) as { created?: string } | null;
  const created = config?.created ? new Date(config.created) : null;
  return created && !Number.isNaN(created.getTime()) ? created : null;
}

async function publishLatest(local: LocalPusher, log: MirrorLogEntry[]): Promise<MirrorLogEntry | null> {
  const candidates = log.filter(
    (e): e is MirrorLogEntry & { digest: string } => !!e.digest && e.status !== "failed",
  );
  if (candidates.length === 0) return null;
  try {
    const pick = await pickNewest(candidates, (d) => imageCreatedAt(local, d));
    if (!pick) return null;
    if ((await local.currentTagDigest("latest")) === pick.digest) {
      return { sourceTag: pick.targetTag, targetTag: "latest", digest: pick.digest, status: "skipped", detail: "latest already points here" };
    }
    const manifest = await local.getManifest(pick.digest);
    await local.putManifest("latest", manifest.bytes, manifest.mediaType);
    return { sourceTag: pick.targetTag, targetTag: "latest", digest: pick.digest, status: "imported", detail: "newest imported image" };
  } catch (err) {
    return { sourceTag: "(newest)", targetTag: "latest", status: "failed", detail: describeError(err) };
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { message?: string; code?: string } }).cause;
  return cause ? `${err.message} (${cause.code ?? ""} ${cause.message ?? ""})`.trim() : err.message;
}

/** Run every enabled mirror (used by the mirror-sync job). */
export async function runAllMirrors(): Promise<{ mirrors: number; succeeded: number; failed: number }> {
  const enabled = await db.query.mirrors.findMany({ where: eq(mirrors.enabled, true) });
  let succeeded = 0;
  let failed = 0;
  for (const m of enabled) {
    const res = await runMirror(m.id).catch(() => ({ status: "failed" }));
    if (res.status === "succeeded") succeeded++;
    else failed++;
  }
  return { mirrors: enabled.length, succeeded, failed };
}

/** Does the target repository already have this tag? (UI helper) */
export async function targetHasTag(repositoryId: string, tag: string): Promise<boolean> {
  const row = await db.query.tags.findFirst({ where: and(eq(tagsTable.repositoryId, repositoryId), eq(tagsTable.name, tag)) });
  return !!row;
}
