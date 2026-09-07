import { formatCount, relativeTime } from "@/lib/format";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { kindNoun, repoShare, shareInstance } from "@/lib/share";
import { shareCard } from "@/lib/share-card";

// A public repository's card; tag, compare and settings pages beneath it
// share the image. Private or missing repositories get the instance card,
// so nothing about them leaks through a link preview.
export const alt = "Repository";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const [instance, share] = await Promise.all([shareInstance(), repoShare(org, decodeRepoParam(repo))]);
  if (!share) {
    return shareCard({ instance, title: instance.name, subtitle: instance.tagline });
  }
  const pull = share.kind === "chart" ? `helm pull oci://${instance.host}/${share.orgSlug}/${share.name}` : `docker pull ${instance.host}/${share.path}`;
  return shareCard({
    instance,
    eyebrow: kindNoun(share.kind),
    title: share.path,
    subtitle: share.description || undefined,
    stats: [
      { label: "Tags", value: String(share.tagCount) },
      { label: "Pulls", value: formatCount(share.pullCount) },
      { label: "Updated", value: share.lastPushedAt ? relativeTime(share.lastPushedAt) : "never" },
    ],
    command: pull,
    picture: share.logoDataUrl,
  });
}
