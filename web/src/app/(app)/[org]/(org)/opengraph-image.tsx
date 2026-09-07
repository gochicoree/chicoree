import { formatCount, relativeTime } from "@/lib/format";
import { orgShare, shareInstance } from "@/lib/share";
import { shareCard } from "@/lib/share-card";

// An organization's card shows only what a visitor could see anyway: its
// public repositories. Unknown organizations get the instance card.
export const alt = "Organization";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const [instance, share] = await Promise.all([shareInstance(), orgShare(slug)]);
  if (!share) {
    return shareCard({ instance, title: instance.name, subtitle: instance.tagline });
  }
  const stats = [{ label: "Public repositories", value: String(share.publicRepos) }];
  if (share.publicRepos > 0) stats.push({ label: "Pulls", value: formatCount(share.pullCount) });
  if (share.lastPushedAt) stats.push({ label: "Updated", value: relativeTime(share.lastPushedAt) });
  return shareCard({
    instance,
    eyebrow: "Organization",
    title: share.name,
    subtitle: share.name === share.slug ? undefined : `${instance.host}/${share.slug}`,
    stats,
    picture: share.logoDataUrl,
    strata: undefined,
  });
}
