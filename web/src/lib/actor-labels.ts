// Labels of machine actors by id, for the places that show who pushed or
// deleted an image (tag page, webhooks, the API's pushedBy). The activity
// feed builds the same strings in SQL (lib/data.ts recentActivity).
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ciIdentitiesTrusted, organization, serviceAccounts } from "@/db/schema";
import { ciActorLabel } from "./ci-auth";
import { serviceAccountHandle } from "./service-account-shared";

/** `acme/ci` for the service account with this id, or null once it is deleted. */
export async function serviceAccountLabel(id: string): Promise<string | null> {
  const [row] = await db
    .select({ name: serviceAccounts.name, slug: organization.slug })
    .from(serviceAccounts)
    .innerJoin(organization, eq(organization.id, serviceAccounts.organizationId))
    .where(eq(serviceAccounts.id, id));
  return row ? serviceAccountHandle(row.slug, row.name) : null;
}

/** `GitHub Actions · acme/release` for the CI identity with this id, or null once it is deleted. */
export async function ciIdentityLabel(id: string): Promise<string | null> {
  const [row] = await db
    .select({ name: ciIdentitiesTrusted.name, issuer: ciIdentitiesTrusted.issuer, slug: organization.slug })
    .from(ciIdentitiesTrusted)
    .innerJoin(organization, eq(organization.id, ciIdentitiesTrusted.organizationId))
    .where(eq(ciIdentitiesTrusted.id, id));
  return row ? ciActorLabel(row.issuer, row.slug, row.name) : null;
}
