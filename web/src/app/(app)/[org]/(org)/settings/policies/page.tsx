import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { RetentionForm } from "@/components/retention-form";
import { TagRulesManager } from "@/components/tag-rules-manager";
import { getRetentionPolicies, toSettings } from "@/lib/retention";
import { listTagRules } from "@/lib/tag-rules";
import { listMemberKeys, listTrustedKeys, listTrustedIdentities } from "@/lib/signatures";
import { SignaturePolicyForm } from "@/components/signature-policy-form";
import { MemberKeysPolicyForm } from "@/components/member-keys-policy-form";
import { TrustedKeysManager } from "@/components/trusted-keys-manager";
import { TrustedIdentitiesManager } from "@/components/trusted-identities-manager";
import { orgSettingsContext } from "../context";

export default async function OrgPoliciesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await orgSettingsContext(params);
  const [settings, rules, retention, keys, memberKeys, identities] = await Promise.all([
    db.query.organizationSettings.findFirst({
      where: eq(organizationSettings.organizationId, org.id),
    }),
    listTagRules(org.id, null),
    getRetentionPolicies(org.id),
    listTrustedKeys(org.id, null),
    listMemberKeys(org.id),
    listTrustedIdentities(org.id, null),
  ]);
  const trustMemberKeys = settings?.trustMemberKeys ?? true;
  return (
    <div className="space-y-6">
      <DefaultVisibilityForm scope="organization" organizationId={org.id} value={settings?.defaultVisibility ?? null} />
      <PullPolicyForm
        scope="organization"
        organizationId={org.id}
        level={settings?.blockPullsAt ?? null}
        unrated={settings?.blockUnrated ?? false}
      />
      <SignaturePolicyForm
        scope="organization"
        organizationId={org.id}
        value={settings?.requireSignature ?? false}
        keyCount={keys.length + (trustMemberKeys ? memberKeys.length : 0) + identities.length}
      />
      <MemberKeysPolicyForm organizationId={org.id} value={trustMemberKeys} memberKeyCount={memberKeys.length} />
      <TrustedKeysManager
        scope="organization"
        organizationId={org.id}
        keys={keys.map((k) => ({
          id: k.id,
          name: k.name,
          fingerprint: k.fingerprint,
          keyType: k.keyType,
          repositoryId: k.repositoryId,
          createdAt: k.createdAt.toISOString(),
        }))}
      />
      <TrustedIdentitiesManager
        scope="organization"
        organizationId={org.id}
        identities={identities.map((i) => ({
          id: i.id,
          name: i.name,
          issuer: i.issuer,
          subject: i.subject,
          repositoryId: i.repositoryId,
          createdAt: i.createdAt.toISOString(),
        }))}
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
