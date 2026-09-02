import type { Metadata } from "next";
import { listPublicRepos } from "@/lib/data";
import { PageHeader } from "@/components/page-header";
import { RepoTable } from "@/components/repo-table";

export const metadata: Metadata = { title: "Explore" };

export default async function ExplorePage() {
  const repos = await listPublicRepos(100);
  return (
    <>
      <PageHeader
        eyebrow="Public"
        title="Explore images"
        description="Every public repository on this registry, most pulled first."
      />
      {repos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3">
          No public repositories yet. Make a repository public in its settings and it will appear here.
        </p>
      ) : (
        <RepoTable repos={repos} showOrg />
      )}
    </>
  );
}
