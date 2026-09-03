import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { RetentionForm } from "@/components/retention-form";
import { TagRulesManager } from "@/components/tag-rules-manager";
import { getRetentionPolicies, toSettings } from "@/lib/retention";
import { listTagRules } from "@/lib/tag-rules";
import { orgSettingsContext } from "../context";

export default async function OrgPoliciesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await orgSettingsContext(params);
  const [settings, rules, retention] = await Promise.all([
    db.query.organizationSettings.findFirst({
      where: eq(organizationSettings.organizationId, org.id),
    }),
    listTagRules(org.id, null),
    getRetentionPolicies(org.id),
  ]);
  return (
    <div className="space-y-6">
      <DefaultVisibilityForm scope="organization" organizationId={org.id} value={settings?.defaultVisibility ?? null} />
      <PullPolicyForm
        scope="organization"
        organizationId={org.id}
        level={settings?.blockPullsAt ?? null}
        unrated={settings?.blockUnrated ?? false}
      />
      <TagRulesManager
        scope="organization"
        organizationId={org.id}
        rules={rules.map((r) => ({
          id: r.id,
          pattern: r.pattern,
          immutable: r.immutable,
          protected: r.protected,
          repositoryId: r.repositoryId,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
      <RetentionForm scope="organization" organizationId={org.id} policy={toSettings(retention.org)} />
    </div>
  );
}
