import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { orgPolicy } from "@/lib/pull-policy";
import { repoSettingsContext } from "../context";

export default async function RepoPolicyPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const orgSettings = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, repo.organizationId),
  });
  return (
    <PullPolicyForm
      scope="repository"
      repositoryId={repo.id}
      level={repo.blockPullsAt ?? null}
      unrated={repo.blockUnrated ?? null}
      inherited={orgPolicy(orgSettings)}
    />
  );
}
