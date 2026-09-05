// Whether a viewer wants signatures, SBOMs and BuildKit attestation entries
// listed next to images. The viewer's own choice (Settings → Display,
// user_settings.show_artifacts) wins; without one the instance default from
// Administration → Branding applies, which is also what anonymous visitors
// of public repositories get.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { getBrandingPlain } from "./branding";

export async function showArtifactsFor(userId: string | null): Promise<boolean> {
  if (userId) {
    const mine = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { showArtifacts: true } });
    if (mine?.showArtifacts != null) return mine.showArtifacts;
  }
  return (await getBrandingPlain()).showArtifacts;
}
