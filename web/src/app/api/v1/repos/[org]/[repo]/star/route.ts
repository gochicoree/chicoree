// PUT / DELETE /api/v1/repos/{org}/{repo}/star — star or unstar a repository.
import { revalidatePath } from "next/cache";
import { loadRepo } from "@/lib/api/access";
import { isReadOnlyToken, requireUser } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { forbidden, json } from "@/lib/api/respond";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { setStar } from "@/lib/stars";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string };

async function star(caller: Parameters<typeof loadRepo>[0], params: Params, starred: boolean) {
  const c = requireUser(caller);
  if (isReadOnlyToken(c)) throw forbidden("This access token is read-only; starring needs a read & write token.");
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const state = await setStar(c.user.id, a.repo.id, starred);
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  revalidatePath("/dashboard");
  return json({ starred: state.starred, count: state.count });
}

export const PUT = route<Params>(async (_req, { caller, params }) => star(caller, params, true));
export const DELETE = route<Params>(async (_req, { caller, params }) => star(caller, params, false));
