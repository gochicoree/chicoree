// GET /api/v1/orgs/{org}/usage — repositories and storage against the organization's limits.
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { getOrgLimits, getOrgUsage } from "@/lib/quota";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "read the usage");
  const [usage, limits] = await Promise.all([getOrgUsage(a.org.id), getOrgLimits(a.org.id)]);
  const pct = (used: number, max: number | null) => (max === null || max === 0 ? null : Math.round((used / max) * 1000) / 10);
  return json({
    organization: a.org.slug,
    usage: { publicRepositories: usage.publicRepos, privateRepositories: usage.privateRepos, storageBytes: usage.storageBytes },
    limits: { maxPublicRepositories: limits.maxPublicRepos, maxPrivateRepositories: limits.maxPrivateRepos, maxStorageBytes: limits.maxStorageBytes },
    percent: { publicRepositories: pct(usage.publicRepos, limits.maxPublicRepos), privateRepositories: pct(usage.privateRepos, limits.maxPrivateRepos), storage: pct(usage.storageBytes, limits.maxStorageBytes) },
  });
});
