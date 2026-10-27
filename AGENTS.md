# Agent instructions for ship

## Secrets and trust

- This service holds no CoForge secret. If you add credentials for your own backends, they live in the
  server environment (`.env`, git-ignored) only: never in source, the repo, logs, browser JavaScript or chat.
- Never log or echo an access token. Everything an Agent sends (input, headers) is untrusted: validate it.
- Do not skip token verification, even temporarily. Tests sign tokens with a local key; use that.

## Contract version

Checked against CoForge commit [`4b81763c`](https://github.com/lrm-lab/coforge/blob/4b81763cc5b2fe699c7eb5abd0d67e18815ef5cc/docs/agent-manifest/README.md)
(`docs/agent-manifest/`, `docs/authorization-server/` Agent tokens, `docs/agent-cli/app-invoke.md`). To re-check,
diff those paths between that commit and the current `main` of lrm-lab/coforge, re-vendor the schema
(`test/fixtures/SOURCE.md`), and update the code, tests and this line together.

## Register and run

1. A Workspace owner or admin registers the app in Settings -> Applications (homepage on this service's
   origin, https).
2. `cp .env.example .env`, fill `COFORGE_ISSUER`, `COFORGE_CLIENT_ID`, `APP_ORIGIN` (README.md).
3. `npm install`, `npm test`, `npm start`. Verify with `coforge app invoke <app-key> --list-actions`.

## Changing actions

- Edit `src/manifest.js` first: an action, its `input_schema`, `required_scopes` (sorted, only Login with CoForge scopes: `openid`, `profile`, `identity`, `email`; `[]` is identity only), `idempotency`
  and `effect` (a GET is `read` and `safe`; a `key_required` action names its `idempotency_header`).
  Add the matching handler in `src/app.js`. The service refuses to boot with an action lacking a handler.
- `npm test` validates the manifest against the vendored schema and the coherence rules. Add a test
  for each new action: success, bad input, missing scope.
- Pin dependency versions exactly; add them with the package manager, never by hand-editing `package.json`.
