// GET /api/mirror/preview?source=docker.io/library/alpine&mode=glob&pattern=3.21.*&exclude=*-rc*
// Lists the source tags a selector would import. Same auth as the jobs API.
import { NextRequest, NextResponse } from "next/server";
import { authenticateJobsRequest } from "@/lib/jobs-auth";
import { selectTags } from "@/lib/mirror";
import { parseSource, RemoteRegistry } from "@/lib/remote-registry";
import type { TagSelector } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateJobsRequest(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const source = q.get("source") ?? "";
  if (!source) return NextResponse.json({ error: "source is required" }, { status: 400 });
  const selector: TagSelector = {
    mode: (q.get("mode") as TagSelector["mode"]) ?? "all",
    pattern: q.get("pattern") ?? "",
    exclude: q.get("exclude") ?? undefined,
  };
  const started = Date.now();
  try {
    const parsed = parseSource(source);
    const remote = new RemoteRegistry(parsed, null);
    const all = await remote.listTags();
    const matched = selectTags(all, selector);
    return NextResponse.json({ source: parsed, total: all.length, matched, ms: Date.now() - started });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err), ms: Date.now() - started }, { status: 502 });
  }
}
