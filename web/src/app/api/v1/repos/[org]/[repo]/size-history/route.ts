// GET /api/v1/repos/{org}/{repo}/size-history?days=90 — compressed size of the newest image pushed each day.
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { sizeSeries } from "@/lib/data";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; repo: string }>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, params.repo);
  const raw = Number(new URL(req.url).searchParams.get("days") ?? "90");
  const days = Number.isInteger(raw) ? Math.min(Math.max(raw, 7), 366) : 90;
  const items = await sizeSeries({ repoId: a.repo.id, days });
  const pushed = items.filter((d) => d.bytes > 0);
  return json({
    days,
    items,
    latest: pushed.length ? pushed[pushed.length - 1] : null,
    peakBytes: pushed.reduce((m, d) => Math.max(m, d.bytes), 0),
  });
});
