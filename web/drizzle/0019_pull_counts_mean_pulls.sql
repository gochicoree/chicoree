-- Pull counts now mean image pulls: a GET of an image or index by a client — not the
-- registry's own reads, not attached artifacts (referrers, cosign tags, BuildKit attestation
-- entries), and not the platform variant fetched by digest right after its index (registryd,
-- handleManifestGet). Recount every repository from the event log under those rules. Old
-- events do not say whether a request was a HEAD, so tooling-heavy repositories stay a
-- little high until the log turns over.
UPDATE "repositories" r SET "pull_count" = (
	SELECT count(*) FROM "events" e
	LEFT JOIN "manifests" m ON m."repository_id" = e."repository_id" AND m."digest" = e."manifest_digest"
	WHERE e."repository_id" = r."id" AND e."type" = 'pull'
		AND NOT (e."actor_type" = 'user' AND e."actor_id" = 'system')
		AND m."subject_digest" IS NULL
		AND coalesce(m."artifact_type", '') <> 'application/vnd.docker.attestation.manifest.v1+json'
		AND coalesce(e."tag", '') !~ '^sha256-[0-9a-f]{64}\.(sig|att|sbom)$'
		AND (coalesce(e."tag", '') <> '' OR NOT EXISTS (
			SELECT 1 FROM "manifest_refs" x
			JOIN "manifests" i ON i."repository_id" = x."repository_id" AND i."digest" = x."manifest_digest"
			WHERE x."repository_id" = e."repository_id" AND x."ref_digest" = e."manifest_digest"
				AND i."media_type" IN ('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json')))
);
