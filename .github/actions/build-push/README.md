# Chicorée build and push

A composite GitHub Action that builds an image with Buildx and pushes it to
a Chicorée registry the way the registry likes it: tagged from a version,
with an SPDX SBOM and SLSA provenance attached by BuildKit, signed with
cosign, and the SBOM attached once more as a signed in-toto attestation of
every platform variant. Sign in first — the [login](../login) action does
it without a stored secret.

```yaml
permissions:
  contents: read
  id-token: write        # OIDC token: registry login and keyless signing

steps:
  - uses: actions/checkout@v7
  - uses: gochicoree/chicoree/.github/actions/login@main
    id: registry
    with:
      registry-url: https://registry.example.com
  - uses: gochicoree/chicoree/.github/actions/build-push@main
    id: image
    with:
      registry: ${{ steps.registry.outputs.registry }}
      registry-url: https://registry.example.com   # for the link in the job summary
      image: acme/api
      version: ${{ github.ref_name }}               # v1.2.3 → 1.2.3, 1.2, 1, latest
      platforms: linux/amd64,linux/arm64
      build-args: |
        VERSION=${{ github.ref_name }}
  - uses: gochicoree/chicoree/.github/actions/scan-gate@main
    with:
      registry-url: https://registry.example.com
      token: ${{ steps.registry.outputs.token }}
      image: acme/api:${{ steps.image.outputs.version }}
      fail-on: high
```

## What ends up in the registry

- **Tags.** `version: 1.2.3` (or `v1.2.3`) pushes `1.2.3`, `1.2` and — from
  1.0.0 on — `1`, and moves `latest`; a pre-release such as `1.2.3-rc.1`
  gets only its own tag. `sha-<short commit>` is added unless `sha-tag` is
  `false`; `tags` adds any others. `latest: true|false` overrides the
  automatic choice.
- **Labels and annotations.** `org.opencontainers.image.source`,
  `.revision`, `.version`, `.created`, `.title`, `.description` and
  `.licenses` from the repository, on the manifests and the index.
- **SBOM and provenance.** BuildKit generates an SPDX SBOM (`sbom: true`;
  `generator=<image>` picks another scanner) and SLSA provenance
  (`provenance: mode=max`; `mode=min` leaves out arguments and
  environment) and stores them as attestation entries of the image index —
  the `unknown/unknown` entries on the tag page, shown under *Build
  attestations*.
- **Signature.** `cosign sign --recursive` signs the index and every
  platform variant. Without `cosign-key` it is keyless: cosign takes the
  job's OIDC identity, Fulcio issues the certificate and Rekor records it;
  the registry shows the workflow URI and verifies the chain, and the
  signature counts as *verified* once the workflow is a *trusted keyless
  identity* of the organization. With `cosign-key` (the PEM of a cosign
  private key, passed from a secret) and `cosign-password`, the signature
  verifies against that key once its public half is a *trusted signing
  key*.
- **Attestations.** `attest: sbom` (the default) reads the SBOM BuildKit
  attached and pushes it as a `spdxjson` attestation of each platform
  variant; `sbom,provenance` does the same with the provenance
  (`slsaprovenance1`). They appear on the Attestations tab with their own
  verification state, and `cosign verify-attestation --type spdxjson`
  works against them. `none` skips this.

The job summary lists the digest, tags, platforms, what was attached and
a link to the tag page when `registry-url` is given.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `registry` | — | Registry host (`cr.example.com`); the login action's `registry` output |
| `image` | — | `org/repo`; a bare name goes to the `library` organization |
| `version` | | Version to tag, with or without a leading `v` |
| `tags` | | Extra tags, comma- or newline-separated |
| `latest` | `auto` | `auto`, `true` or `false` |
| `sha-tag` | `true` | Also tag `sha-<short commit>` |
| `context` | `.` | Build context |
| `file` | `<context>/Dockerfile` | Dockerfile, relative to the workspace |
| `target` | | Build stage |
| `platforms` | `linux/amd64` | Comma-separated; others than the runner's run under QEMU unless the Dockerfile cross-compiles |
| `build-args` | | `KEY=value` lines; they are recorded in the provenance, so no secrets |
| `labels` | | Extra `key=value` lines |
| `sbom` | `true` | `true`, `false` or `generator=<image>` |
| `provenance` | `mode=max` | `mode=max`, `mode=min` or `false` |
| `sign` | `true` | Sign with cosign |
| `attest` | `sbom` | `sbom`, `sbom,provenance` or `none` |
| `cosign-key` | | PEM of a cosign private key; empty signs keylessly |
| `cosign-password` | | Its password |
| `cosign-args` | | Extra flags for `cosign sign` and `cosign attest` |
| `cache` | `true` | Build cache in the GitHub Actions cache |
| `push` | `true` | `false` only builds (nothing to sign) |
| `registry-url` | | Base URL of the web app, for the summary link |

Outputs: `digest`, `ref` (`registry/org/repo@digest`), `tags` (full
references, one per line), `version`, `platforms`.

## Notes

- Multi-platform builds run in one job. Let the Dockerfile do the heavy
  work on the builder's platform (`FROM --platform=$BUILDPLATFORM …` for
  the compile stage, `GOOS`/`GOARCH` or a JavaScript build that runs
  once) and QEMU only has to run the last stage's `apk add` — the
  Dockerfiles in this repository show the pattern. Native runners per
  platform work as well: call the action once per runner with a single
  platform and a version each, or without a version and with `tags`.
- The registry's *Require signatures* policy blocks pulls of images whose
  signature is not verified; trust the key or the workflow identity before
  switching it on, or the image pushed by this action is blocked too.
- `attach.sh` does the post-push work (inspect the index, sign, attest,
  summarise) and runs with plain `docker`, `cosign` and `jq`, so it can be
  tried locally: `REGISTRY=… IMAGE=org/repo DIGEST=sha256:… TAGS=… SIGN=true
  ATTEST=sbom COSIGN_ARGS=--allow-http-registry GITHUB_STEP_SUMMARY=/tmp/s
  GITHUB_OUTPUT=/tmp/o ./attach.sh`.
