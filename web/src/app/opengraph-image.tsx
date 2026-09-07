import { shareCard } from "@/lib/share-card";
import { shareInstance } from "@/lib/share";

// The instance's own card: the landing page, Explore, search and every page
// without a more specific image share it.
export const alt = "Container registry";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const instance = await shareInstance();
  return shareCard({
    instance,
    title: instance.name,
    subtitle: instance.tagline,
    command: `docker login ${instance.host}`,
    strata: [41, 26, 63, 18, 88, 34, 52, 22],
  });
}
