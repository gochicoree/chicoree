# Chicorée actions

Composite GitHub Actions for pipelines that push to a Chicorée registry —
this repository's own releases use them, and so can yours:

- [`login`](login) — signs the job in with its OIDC token; no stored secret.
- [`build-push`](build-push) — builds with Buildx, pushes with SBOM and
  provenance, signs with cosign, attests the SBOM.
- [`scan-gate`](scan-gate) — fails the job on the registry's scan verdict.

[`../workflows/release-images.yml`](../workflows/release-images.yml) chains
the three into a reusable workflow that takes a list of images. How to
reference them, what to trust on the registry and what each one produces:
[README.md → GitHub Actions](../../README.md#github-actions).
