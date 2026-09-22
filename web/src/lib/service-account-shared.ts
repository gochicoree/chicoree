// How service accounts and CI identities are named wherever they act or
// are listed. A name is only unique within its organization, so the
// organization's slug goes in front — `acme/ci`, like an image path — and
// two organizations' `ci` accounts never look alike in the activity feed,
// on a tag page, in the audit log, in webhooks or in the API. Safe for
// client components.

/** `<organization slug>/<name>` — the handle of a service account or CI identity. */
export function serviceAccountHandle(organizationSlug: string, name: string): string {
  return `${organizationSlug}/${name}`;
}
