// Authorization logic shared by the Docker token endpoint and (conceptually)
// the UI: who may pull/push/delete in which repository.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ROLE_REGISTRY_ACTIONS, type OrgRole } from "./org-roles";
import {
  member,
  organization,
  organizationProxies,
  organizationSettings,
  repositories,
  serviceAccounts,
  user as userTable,
} from "@/db/schema";
import { isDockerHubUrl, proxyLocalName } from "./proxy-shared";

export type RegistryAction = "pull" | "push" | "delete";

export type Caller =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; isAdmin: boolean; patScope: "read" | "write" | null }
  | {
      kind: "sa";
      saId: string;
      organizationId: string;
      permission: "pull" | "push" | "admin";
      repositoryIds: string[] | null;
    };

export function callerSubject(caller: Caller): string {
  switch (caller.kind) {
    case "user":
      return `user:${caller.userId}`;
    case "sa":
      return `sa:${caller.saId}`;
    default:
      return "anonymous";
  }
}


/**
 * Compute which of the requested actions the caller may perform on
 * <orgSlug>/<repoName>. Repositories that don't exist yet can still be
 * granted push (they are created on first push) when the caller may write to
 * the organization.
 */
export async function allowedRepositoryActions(
  caller: Caller,
  orgSlug: string,
  repoName: string,
  requested: RegistryAction[],
): Promise<RegistryAction[]> {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, orgSlug) });
  if (!org) return [];

  // Proxy caches: nested names are only valid there, Docker Hub library
  // images are stored under their short name, and nobody pushes — the
  // registry fills the cache itself.
  const proxy = await db.query.organizationProxies.findFirst({
    where: eq(organizationProxies.organizationId, org.id),
  });
  if (repoName.includes("/") && !proxy) return [];
  if (proxy) repoName = proxyLocalName(isDockerHubUrl(proxy.upstreamUrl), repoName);

  const repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)),
  });
  // A repository the proxy has not cached yet is as visible as it will be
  // once created: the organization's default visibility.
  let visibility: string | undefined = repo?.visibility;
  if (!repo && proxy) {
    const settings = await db.query.organizationSettings.findFirst({
      where: eq(organizationSettings.organizationId, org.id),
    });
    visibility = settings?.defaultVisibility ?? "private";
  }

  let allowed: RegistryAction[] = [];

  switch (caller.kind) {
    case "anonymous":
      allowed = visibility === "public" ? ["pull"] : [];
      break;

    case "user": {
      if (caller.isAdmin) {
        allowed = ["pull", "push", "delete"];
      } else {
        const membership = await db.query.member.findFirst({
          where: and(eq(member.organizationId, org.id), eq(member.userId, caller.userId)),
        });
        allowed = membership ? [...(ROLE_REGISTRY_ACTIONS[membership.role as OrgRole] ?? ["pull"])] : [];
        if (allowed.length === 0 && visibility === "public") allowed = ["pull"];
      }
      if (caller.patScope === "read") allowed = allowed.filter((a) => a === "pull");
      break;
    }

    case "sa": {
      if (caller.organizationId !== org.id) {
        allowed = visibility === "public" ? ["pull"] : [];
        break;
      }
      if (caller.repositoryIds) {
        // Restricted SAs only reach repositories that already exist and are
        // explicitly listed — no auto-create.
        if (!repo || !caller.repositoryIds.includes(repo.id)) {
          allowed = [];
          break;
        }
      }
      allowed =
        caller.permission === "admin"
          ? ["pull", "push", "delete"]
          : caller.permission === "push"
            ? ["pull", "push"]
            : ["pull"];
      break;
    }
  }

  if (proxy) allowed = allowed.filter((a) => a === "pull");
  return requested.filter((a) => allowed.includes(a));
}

/** Instance admins (user.role = 'admin') may list the full catalog. */
export async function mayAccessCatalog(caller: Caller): Promise<boolean> {
  if (caller.kind !== "user") return false;
  if (caller.isAdmin) return true;
  const u = await db.query.user.findFirst({ where: eq(userTable.id, caller.userId) });
  return u?.role === "admin";
}

/** Look up a service account row by credential hash. */
export async function findServiceAccountByHash(hash: string) {
  return db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.tokenHash, hash) });
}
