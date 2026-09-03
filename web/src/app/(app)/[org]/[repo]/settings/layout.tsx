import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NavTabs } from "@/components/ui/nav-tabs";
import { repoSettingsContext } from "./context";

export default async function RepoSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; repo: string }>;
}) {
  const { orgSlug, repoName, base } = await repoSettingsContext(params);
  return (
    <div>
      <Link href={`/${orgSlug}/${repoName}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {orgSlug}/{repoName}
      </Link>
      <div className="mb-4">
        <div className="eyebrow mb-1">Repository settings</div>
        <h1 className="break-all font-display text-xl font-bold tracking-tight">
          <span className="text-ink-2">{orgSlug}/</span>
          {repoName}
        </h1>
      </div>
      <NavTabs
        variant="pills"
        className="mb-6"
        items={[
          { href: base, label: "General", exact: true },
          { href: `${base}/policy`, label: "Pull policy" },
          { href: `${base}/webhooks`, label: "Webhooks" },
          { href: `${base}/mirror`, label: "Mirror" },
          { href: `${base}/danger`, label: "Danger zone" },
        ]}
      />
      {children}
    </div>
  );
}
