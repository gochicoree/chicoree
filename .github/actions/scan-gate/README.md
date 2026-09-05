# Chicorée scan gate

A composite GitHub Action that fails the job when an image in a Chicorée
registry has vulnerabilities at or above a severity. It talks to the
registry's REST API (`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/scan`),
waits for a running scan, applies the organization's accepted risks, and
writes the verdict to the job summary.

```yaml
- uses: ruohki/chicoree/.github/actions/scan-gate@main
  with:
    registry-url: https://registry.example.com
    token: ${{ secrets.REGISTRY_TOKEN }}     # or the token from the login action
    image: acme/api:${{ github.sha }}
    fail-on: high        # critical | high | medium | low
    unrated: "false"     # also fail on findings without a rating
    wait: "240"          # seconds to wait for a running scan
    scan: "false"        # "true" queues a fresh scan first (administrator token)
```

Outputs: `passed` (`true`/`false`), `digest`, `summary` (severity counts
after accepted risks, JSON). Needs `curl` and `jq`, both present on the
hosted runners.
