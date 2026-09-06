# Chicorée login (keyless)

Signs a GitHub Actions job in to a Chicorée registry with the job's own
OIDC token. Nothing is stored in the repository's secrets: the organization
trusts the workflow's identity once (*Organization → Service accounts → CI
identities*, or `POST /api/v1/orgs/{org}/ci-identities`), and every job
exchanges its token for a credential that lives as long as the job.

```yaml
permissions:
  id-token: write      # lets the job request an OIDC token
  contents: read

steps:
  - uses: gochicoree/chicoree/.github/actions/login@main
    id: registry
    with:
      registry-url: https://registry.example.com
      organization: acme          # only needed when several organizations trust this workflow
  - run: docker build -t ${{ steps.registry.outputs.registry }}/acme/api:${{ github.sha }} . && docker push ${{ steps.registry.outputs.registry }}/acme/api:${{ github.sha }}
  - uses: gochicoree/chicoree/.github/actions/scan-gate@main
    with:
      registry-url: https://registry.example.com
      token: ${{ steps.registry.outputs.token }}
      image: acme/api:${{ github.sha }}
      fail-on: high
```

The trusted identity's subject is what GitHub puts in the token's `sub`
claim: `repo:owner/repo:ref:refs/heads/main` for a branch,
`repo:owner/repo:environment:production` for an environment, or
`repo:owner/repo:*` for any ref of the repository. The token is requested
with the registry URL as audience, which the exchange checks.

Outputs: `token` (masked in the log), `registry`, `username`, `expires-at`.
`docker-login: "false"` skips the `docker login` step.
