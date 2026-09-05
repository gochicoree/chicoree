# Chicorée — project rules

Read `README.md` (what it does) and `ARCHITECTURE.md` (how) first.

## The REST API follows the features

`/api/v1` (`web/src/app/api/v1`, `web/src/lib/api/`) is a public contract that
is kept in step with the product. **Whenever a feature is added, changed or
removed, update the API in the same change**:

1. Add, adjust or remove the route handler(s) under `web/src/app/api/v1`.
   Reuse the same library functions the UI's server actions use, so both
   behave identically; audit writes with `via: "api"`.
2. Update the endpoint's entry in `web/src/lib/api/catalog.ts` (parameters,
   access, example response). Field names in the examples are the contract.
3. Add a line to the newest entry of `API_CHANGELOG` in
   `web/src/lib/api/version.ts` — or start a new revision (`YYYY-MM-DD.n`)
   when the previous one is already released. Prefix removals with
   `Removed:` and breaking changes with `Breaking:`.
4. Run `npm run api:docs` in `web/` to regenerate `API.md`, then
   `npm run lint` (typecheck + `api:check`, which fails on undocumented
   routes, orphaned catalog entries or a stale `API.md`).

The in-app browser (`/docs/api`), the OpenAPI document
(`/api/v1/openapi.json`) and the JSON index (`GET /api/v1`) are all rendered
from the catalog and need no separate edits.

## Other conventions

- Commit messages must not mention the assistant or Anthropic.
- `web/src/db/registry-schema.ts` and `registryd/internal/store/store.go`
  are one shared table contract: change them together and add a migration.
- UI helper text is short and written for users, not operators; the long
  explanations belong in `README.md`.
