import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { RetentionForm } from "@/components/retention-form";
import { TagRulesManager, type TagRuleItem } from "@/components/tag-rules-manager";
import { orgPolicy } from "@/lib/pull-policy";
import { getRetentionPolicies, toSettings } from "@/lib/retention";
import { listTagRules, type TagRuleRow } from "@/lib/tag-rules";
import { repoSettingsContext } from "../context";

function serializeRules(rows: TagRuleRow[]): TagRuleItem[] {
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    immutable: r.immutable,
    protected: r.protected,
    repositoryId: r.repositoryId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export default async function RepoPolicyPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const [orgSettings, rules, orgRules, retention] = await Promise.all([
    db.query.organizationSettings.findFirst({
      where: eq(organizationSettings.organizationId, repo.organizationId),
    }),
    listTagRules(repo.organizationId, repo.id),
    listTagRules(repo.organizationId, null),
    getRetentionPolicies(repo.organizationId, repo.id),
  ]);
  return (
    <div className="space-y-6">
      <PullPolicyForm
        scope="repository"
        repositoryId={repo.id}
        level={repo.blockPullsAt ?? null}
        unrated={repo.blockUnrated ?? null}
        inherited={orgPolicy(orgSettings)}
      />
      <TagRulesManager
        scope="repository"
        organizationId={repo.organizationId}
        repositoryId={repo.id}
        rules={serializeRules(rules)}
        inherited={serializeRules(orgRules)}
      />
      <RetentionForm
        scope="repository"
        organizationId={repo.organizationId}
        repositoryId={repo.id}
        policy={toSettings(retention.repo)}
        inherited={toSettings(retention.org)}
      />
    </div>
  );
}
