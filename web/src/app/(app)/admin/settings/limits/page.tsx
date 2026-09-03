import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../../admin-nav";
import { RateLimitForm } from "./limits-form";

export const metadata: Metadata = { title: "Rate limits" };

export default async function AdminRateLimitSettings() {
  await requireAdmin();
  const s = await getInstanceSettings();
  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Pull rate limits enforced by the registry. Values saved here apply within 30 seconds and override the environment."
      />
      <AdminNav />
      <RateLimitForm values={s.ratelimit} source={s.sources.ratelimit} />
    </>
  );
}
