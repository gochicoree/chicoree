import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { RetentionForm } from "@/components/retention-form";
import { TagRulesManager, type TagRuleItem } from "@/components/tag-rules-manager";
import { orgPolicy } from "@/lib/pull-policy";
import { getRetentionPolicies, toSettings } from "@/lib/retention";
import { listTagRules, type TagRuleRow } from "@/lib/tag-rules";
import { listTrustedKeys, type TrustedKeyRow } from "@/lib/signatures";
import { SignaturePolicyForm } from "@/components/signature-policy-form";
import { TrustedKeysManager, type TrustedKeyItem } from "@/components/trusted-keys-manager";
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

function serializeKeys(rows: TrustedKeyRow[]): TrustedKeyItem[] {
  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    fingerprint: k.fingerprint,
    keyType: k.keyType,
    repositoryId: k.repositoryId,
    createdAt: k.createdAt.toISOString(),
  }));
}

export default async function RepoPolicyPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const [orgSettings, rules, orgRules, retention, keys, orgKeys] = await Promise.all([
    db.query.organizationSettings.findFirst({
      where: eq(organizationSettings.organizationId, repo.organizationId),
    }),
    listTagRules(repo.organizationId, repo.id),
    listTagRules(repo.organizationId, null),
    getRetentionPolicies(repo.organizationId, repo.id),
    listTrustedKeys(repo.organizationId, repo.id),
    listTrustedKeys(repo.organizationId, null),
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
      <SignaturePolicyForm
        scope="repository"
        repositoryId={repo.id}
        value={repo.requireSignature ?? null}
        inherited={orgSettings?.requireSignature ?? false}
        keyCount={keys.length + orgKeys.length}
      />
      <TrustedKeysManager
        scope="repository"
        organizationId={repo.organizationId}
        repositoryId={repo.id}
        keys={serializeKeys(keys)}
        inherited={serializeKeys(orgKeys)}
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
