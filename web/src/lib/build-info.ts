// What this web app was built from: APP_VERSION and APP_COMMIT are baked into
// the image as build arguments (the release workflow passes the tag and the
// commit, scripts/deploy.sh the local checkout's), and are empty in
// development. Shown in the footer and as `build` in GET /api/v1.

export interface BuildInfo {
  /** Release version without a leading v, e.g. 0.1.5; empty when the build was not a tagged release. */
  version: string;
  /** Short commit id, e.g. 364d6d4; empty when unknown. */
  commit: string;
}

export function buildInfo(): BuildInfo {
  const version = (process.env.APP_VERSION ?? "").trim().replace(/^v/, "");
  const commit = (process.env.APP_COMMIT ?? "").trim().slice(0, 7);
  return { version, commit };
}

/** One short line for the footer: "v0.1.5 (364d6d4)", "364d6d4", or "" in development. */
export function buildLabel(info: BuildInfo = buildInfo()): string {
  if (info.version && info.commit) return `v${info.version} (${info.commit})`;
  if (info.version) return `v${info.version}`;
  return info.commit;
}
