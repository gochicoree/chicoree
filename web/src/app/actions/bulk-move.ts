"use server";

// Moving many repositories to one organization in a single run
// (/admin/organizations/move). Instance administrators only.
//
// Two actions: `previewBulkMove` runs every check without writing anything,
// `runBulkMove` re-checks and performs the moves one at a time so the target's
// repository and storage quotas are counted against what has actually landed.
// Both share the rules with the repository danger zone through
// `lib/repo-move.ts`, so a bulk move is exactly N single transfers.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { getOrgLimits, getOrgUsage, type Limits, type Usage } from "@/lib/quota";
import { recordAudit } from "@/lib/audit";
import {
  MAX_BULK_MOVE,
  moveRepositoryToOrganization,
  planBulkMove,
  type MoveActor,
  type MovePlan,
  type MoveSkipCode,
} from "@/lib/repo-move";

/** One repository in a preview or a run. */
export interface BulkMoveRow {
  repositoryId: string;
  name: string;
  sourceSlug: string;
  sourceName: string;
  visibility: "public" | "private";
  /** Preview: it would move. Run: it moved. */
  ok: boolean;
  code: MoveSkipCode | null;
  /** Why it will be / was skipped. */
  message: string | null;
  /** Bytes this repository adds to the target that it does not already hold. */
  bytesNew: number;
}

export interface BulkMovePreview {
  error?: string;
  target?: { id: string; slug: string; name: string };
  rows: BulkMoveRow[];
  /** How many of `rows` would move. */
  movable: number;
  skipped: number;
  /** Bytes new to the target across every repository that would move. */
  totalBytesNew: number;
  usage?: Usage;
  limits?: Limits;
  /** Usage of the target after the run. */
  resulting?: { storageBytes: number; publicRepos: number; privateRepos: number };
}

export interface BulkMoveRun {
  error?: string;
  target?: { id: string; slug: string; name: string };
  rows: BulkMoveRow[];
  moved: number;
  failed: number;
  bytesMoved: number;
}

function readInput(formData: FormData): { targetId: string; ids: string[] } {
  const targetId = String(formData.get("targetOrganizationId") ?? "");
  // De-duplicate while keeping the order the administrator selected them in.
  const ids = [...new Set(formData.getAll("repositoryIds").map((v) => String(v)).filter(Boolean))];
  return { targetId, ids };
}

function problemWithInput(targetId: string, ids: string[]): string | null {
  if (!targetId) return "Choose the organization to move the repositories into.";
  if (ids.length === 0) return "Select at least one repository.";
  if (ids.length > MAX_BULK_MOVE) {
    return `One run moves at most ${MAX_BULK_MOVE} repositories (${ids.length} selected). Move them in smaller batches so quota accounting stays correct.`;
  }
  return null;
}

function toRow(plan: MovePlan, ok: boolean): BulkMoveRow {
  return {
    repositoryId: plan.repositoryId,
    name: plan.repositoryName,
    sourceSlug: plan.source?.slug ?? "",
    sourceName: plan.source?.name ?? "",
    visibility: plan.visibility,
    ok,
    code: plan.code,
    message: plan.message,
    bytesNew: plan.bytesNew,
  };
}

async function actor(): Promise<{ actor: MoveActor }> {
  const session = await requireAdmin();
  return { actor: { userId: session.user.id, userName: session.user.name, isAdmin: true } };
}

/** Everything a run would do, without writing anything. */
export async function previewBulkMove(formData: FormData): Promise<BulkMovePreview> {
  const { targetId, ids } = readInput(formData);
  const { actor: who } = await actor();
  const problem = problemWithInput(targetId, ids);
  if (problem) return { error: problem, rows: [], movable: 0, skipped: 0, totalBytesNew: 0 };

  const target = await db.query.organization.findFirst({ where: eq(organization.id, targetId) });
  if (!target) return { error: "Organization not found.", rows: [], movable: 0, skipped: 0, totalBytesNew: 0 };

  const plans = await planBulkMove(ids, targetId, who);
  const rows = plans.map((p) => toRow(p, p.ok));
  const movable = rows.filter((r) => r.ok);
  const totalBytesNew = movable.reduce((sum, r) => sum + r.bytesNew, 0);
  const [usage, limits] = await Promise.all([getOrgUsage(targetId), getOrgLimits(targetId)]);

  return {
    target: { id: target.id, slug: target.slug, name: target.name },
    rows,
    movable: movable.length,
    skipped: rows.length - movable.length,
    totalBytesNew,
    usage,
    limits,
    resulting: {
      storageBytes: usage.storageBytes + totalBytesNew,
      publicRepos: usage.publicRepos + movable.filter((r) => r.visibility === "public").length,
      privateRepos: usage.privateRepos + movable.filter((r) => r.visibility === "private").length,
    },
  };
}

/**
 * Perform the moves, one after another, continuing past failures. Each move
 * is committed before the next is checked, so quotas see what has landed.
 */
export async function runBulkMove(formData: FormData): Promise<BulkMoveRun> {
  const { targetId, ids } = readInput(formData);
  const { actor: who } = await actor();
  const problem = problemWithInput(targetId, ids);
  if (problem) return { error: problem, rows: [], moved: 0, failed: 0, bytesMoved: 0 };

  const target = await db.query.organization.findFirst({ where: eq(organization.id, targetId) });
  if (!target) return { error: "Organization not found.", rows: [], moved: 0, failed: 0, bytesMoved: 0 };

  const rows: BulkMoveRow[] = [];
  for (const id of ids) {
    try {
      const result = await moveRepositoryToOrganization({ repositoryId: id, targetOrganizationId: targetId, actor: who });
      rows.push(toRow(result, result.moved));
    } catch (err) {
      console.error("bulk move failed for", id, err);
      rows.push({
        repositoryId: id,
        name: "",
        sourceSlug: "",
        sourceName: "",
        visibility: "private",
        ok: false,
        code: "failed",
        message: err instanceof Error ? err.message : "The move failed.",
        bytesNew: 0,
      });
    }
  }

  const moved = rows.filter((r) => r.ok);
  // One summary entry for the run itself; every individual move is already
  // audited in both organizations by moveRepositoryToOrganization().
  await recordAudit({
    action: "repo.bulk_transfer",
    organizationId: target.id,
    targetType: "organization",
    targetId: target.id,
    targetLabel: target.slug,
    details: {
      requested: ids.length,
      moved: moved.length,
      skipped: rows.length - moved.length,
      bytesAdded: moved.reduce((s, r) => s + r.bytesNew, 0),
      repositories: moved.map((r) => `${r.sourceSlug}/${r.name} → ${target.slug}/${r.name}`),
    },
  });

  return {
    target: { id: target.id, slug: target.slug, name: target.name },
    rows,
    moved: moved.length,
    failed: rows.length - moved.length,
    bytesMoved: moved.reduce((s, r) => s + r.bytesNew, 0),
  };
}
