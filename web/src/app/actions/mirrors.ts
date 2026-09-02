"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mirrors, organization, repositories, type Relabel, type TagSelector } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES, WRITER_ROLES } from "@/lib/org-roles";
import { encryptSecret } from "@/lib/crypto";
import { checkRepoQuota } from "@/lib/quota";
import { runMirror, selectTags } from "@/lib/mirror";
import { parseSource, RemoteRegistry } from "@/lib/remote-registry";

export interface MirrorResult {
  error?: string;
  saved?: boolean;
  preview?: { total: number; matched: string[] };
}

const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function readSelector(formData: FormData): TagSelector | { error: string } {
  const mode = String(formData.get("selectorMode") ?? "all") as TagSelector["mode"];
  if (!["all", "glob", "regex", "list"].includes(mode)) return { error: "Invalid tag selector." };
  const pattern = String(formData.get("pattern") ?? "").trim();
  const exclude = String(formData.get("exclude") ?? "").trim();
  if (mode !== "all" && !pattern) return { error: "Enter a tag pattern." };
  if (mode === "regex") {
    try {
      new RegExp(pattern);
      if (exclude) new RegExp(exclude);
    } catch {
      return { error: "Invalid regular expression." };
    }
  }
  return { mode, pattern, exclude: exclude || undefined };
}

function readRelabel(formData: FormData): Relabel {
  return {
    tagTemplate: String(formData.get("tagTemplate") ?? "{tag}").trim() || "{tag}",
    replaceFrom: String(formData.get("replaceFrom") ?? "").trim() || undefined,
    replaceTo: String(formData.get("replaceTo") ?? "").trim() || undefined,
    latest: formData.getAll("latest").includes("on"),
  };
}

async function repoContext(repositoryId: string, roles: string[]) {
  await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." } as const;
  const role = await getOrgRole(repo.organizationId);
  if (!role || !roles.includes(role)) return { error: "You don't have permission to do that." } as const;
  const org = (await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) }))!;
  return { repo, org } as const;
}

/** Create or update the mirror configuration of an existing repository. */
export async function saveMirror(_prev: MirrorResult | null, formData: FormData): Promise<MirrorResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const ctx = await repoContext(repositoryId, MANAGER_ROLES);
  if ("error" in ctx) return { error: ctx.error };
  const selector = readSelector(formData);
  if ("error" in selector) return { error: selector.error };
  const source = String(formData.get("source") ?? "").trim();
  if (!source) return { error: "Enter a source repository." };
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const overwrite = formData.get("overwrite") === "on";
  const enabled = formData.get("enabled") !== "off";
  const session = await requireSession();

  const existing = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, repositoryId) });
  const sourceAuth = username
    ? encryptSecret(`${username}:${password}`)
    : password === "-"
      ? null
      : (existing?.sourceAuth ?? null);
  const values = { source, sourceAuth, selector, relabel: readRelabel(formData), overwrite, enabled };
  if (existing) {
    await db.update(mirrors).set(values).where(eq(mirrors.id, existing.id));
  } else {
    await db.insert(mirrors).values({ repositoryId, createdBy: session.user.id, ...values });
  }
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
  return { saved: true };
}

export async function deleteMirror(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const ctx = await repoContext(repositoryId, MANAGER_ROLES);
  if ("error" in ctx) return;
  await db.delete(mirrors).where(eq(mirrors.repositoryId, repositoryId));
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
}

/** Kick off a run in the background. */
export async function runMirrorNow(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const ctx = await repoContext(repositoryId, WRITER_ROLES);
  if ("error" in ctx) return;
  const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, repositoryId) });
  if (!mirror) return;
  after(async () => {
    await runMirror(mirror.id).catch((err) => console.error("mirror run failed:", err));
  });
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
}

/** Dry run: list the source tags the selector would pick. */
export async function previewMirror(_prev: MirrorResult | null, formData: FormData): Promise<MirrorResult> {
  await requireSession();
  const selector = readSelector(formData);
  if ("error" in selector) return { error: selector.error };
  const source = String(formData.get("source") ?? "").trim();
  if (!source) return { error: "Enter a source repository." };
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  try {
    const remote = new RemoteRegistry(parseSource(source), username ? { username, password } : null);
    const all = await remote.listTags();
    const matched = selectTags(all, selector);
    return { preview: { total: all.length, matched: matched.slice(0, 200) } };
  } catch (err) {
    return { error: `Could not list tags: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Import flow: create the repository, configure the mirror, start the first run. */
export async function createImport(_prev: MirrorResult | null, formData: FormData): Promise<MirrorResult> {
  const session = await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(organizationId);
  if (!role || !WRITER_ROLES.includes(role)) return { error: "You don't have permission to import here." };
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." };

  const name = String(formData.get("name") ?? "").trim();
  if (!NAME_RE.test(name)) return { error: "Repository names use lowercase letters, digits and single ._- separators." };
  const visibility = formData.get("visibility") === "public" ? "public" : "private";
  const selector = readSelector(formData);
  if ("error" in selector) return { error: selector.error };
  const source = String(formData.get("source") ?? "").trim();
  if (!source) return { error: "Enter a source repository." };
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  let repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, organizationId), eq(repositories.name, name)),
  });
  if (repo) {
    const existingMirror = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, repo.id) });
    if (existingMirror) return { error: `${name} already has a mirror configured; edit it in the repository settings.` };
  } else {
    const quota = await checkRepoQuota(organizationId, visibility, org.name);
    if (quota) return { error: quota };
    [repo] = await db
      .insert(repositories)
      .values({ organizationId, name, visibility, description: `Mirror of ${source}` })
      .returning();
  }

  const [mirror] = await db
    .insert(mirrors)
    .values({
      repositoryId: repo.id,
      source,
      sourceAuth: username ? encryptSecret(`${username}:${password}`) : null,
      selector,
      relabel: readRelabel(formData),
      overwrite: formData.get("overwrite") === "on",
      enabled: true,
      createdBy: session.user.id,
    })
    .returning();
  after(async () => {
    await runMirror(mirror.id).catch((err) => console.error("mirror run failed:", err));
  });
  revalidatePath(`/${org.slug}`);
  redirect(`/${org.slug}/${repo.name}/settings#mirror`);
}
