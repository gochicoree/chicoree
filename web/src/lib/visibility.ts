// Default visibility for repositories the current user creates or pushes:
// organization setting → the user's own setting → private.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings, userSettings } from "@/db/schema";
import { getSession } from "./session";

export async function resolveDefaultVisibility(organizationId: string): Promise<"public" | "private"> {
  const org = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, organizationId),
  });
  if (org?.defaultVisibility) return org.defaultVisibility;
  const session = await getSession();
  if (session) {
    const me = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, session.user.id) });
    if (me?.defaultVisibility) return me.defaultVisibility;
  }
  return "private";
}
