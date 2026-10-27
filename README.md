# ship

An HTTP service that a CoForge Agent calls with `coforge app invoke`. It publishes an Agent
manifest, verifies the short-lived access token CoForge gives the Agent, checks the action's
scopes, validates input, and honours an idempotency key. Built on [Hono](https://hono.dev) and
[jose](https://github.com/panva/jose); it runs on Node 22+ and Bun. It does not implement
Login with CoForge for people: use the `pure-sign-in-web-app` template for that.

## What it serves

| Route | Auth | Does |
| --- | --- | --- |
| `GET /.well-known/coforge-agent-manifest.json` | none | The `coforge-agent-manifest.v1` document (`src/manifest.js`). |
| `GET /api/notes/{id}` | Bearer | Action `notes.get` (effect `read`, idempotency `safe`). |
| `POST /api/notes` | Bearer, header `Idempotency-Key` | Action `notes.create` (effect `create`, idempotency `key_required`). |
| `GET /healthz` | none | Liveness. |

Routes, input checks and scope checks are all generated from the actions in `src/manifest.js`, so the
manifest cannot drift from what the service does. Notes are kept in memory per Workspace; replace
the handlers in `src/app.js` with your own logic and storage.

## Environment variables

Copy `.env.example` to `.env`.

| Variable | Meaning |
| --- | --- |
| `COFORGE_ISSUER` | `<your CoForge origin>/oidc`, no trailing slash. Keys come from `<issuer>/jwks`. |
| `COFORGE_CLIENT_ID` | The app's client ID (key). Agent tokens carry it as `aud`. |
| `APP_ORIGIN` | The public https origin of this service. The manifest's `execution.base_url` is `APP_ORIGIN/api`. |
| `PORT` | Listen port, default 3000. |

This service holds no client secret: it only verifies tokens.

## Register and try it

1. In your Workspace, register the app in Settings -> Applications. Give it a homepage on the same
   origin as this service (or the explicit manifest URL): the Agent CLI accepts `base_url` only on the
   origin of the homepage or the manifest URL, and requires https.
2. Install the app and let the Agent have access (the first use of `coforge app token` / `coforge app invoke`
   grants it, or a person approves it).
3. Deploy this service at `APP_ORIGIN` and, as an Agent:

```bash
coforge app invoke <app-key> --list-actions
coforge app invoke <app-key> notes.create --param title="First note"
coforge app invoke <app-key> notes.get --param id=<id from the call above>
```

The CLI generates and prints the idempotency key for `notes.create`; repeat a call with
`--idempotency-key <key>` and the service answers from the first run (`Idempotency-Replayed: true`).

## Request handling

- Input is built as the manifest promises: path parameters, then the query string (GET, DELETE) or the JSON
  body. Query strings are converted back to the schema's declared `integer`, `number`, `boolean` and
  array types before validation, as `coforge app invoke` sent them; anything that does not parse is a 400.
- Bodies over 64 KiB are refused with 413 (Hono's `bodyLimit`; chunked bodies included).
- A `key_required` action reserves its `Idempotency-Key` *before* the handler runs. A duplicate that arrives
  while the first call is still running gets `409 request_in_progress` with `Retry-After: 1`; once the first
  call succeeds, repeats get its stored answer (`Idempotency-Replayed: true`). A failed call (non-2xx or an
  exception) releases the key so a retry can run. The same key with different input is `422`.

## Tokens

An Agent token is an RFC 9068 JWT: ES256, header `typ: at+jwt`, valid five minutes
([claims](https://github.com/lrm-lab/coforge/blob/4b81763cc5b2fe699c7eb5abd0d67e18815ef5cc/docs/authorization-server/README.md#agent-tokens), minted in
[`issued-tokens.server.ts`](https://github.com/lrm-lab/coforge/blob/4b81763cc5b2fe699c7eb5abd0d67e18815ef5cc/apps/web/src/server/authorization-server/issued-tokens.server.ts)).
The service checks the signature by `kid` against `<issuer>/jwks`, `typ`, `iss` = `COFORGE_ISSUER`, `aud` =
`COFORGE_CLIENT_ID`, `exp`, and `type: "agent"`. `sub` is the Agent id; `workspace_id` partitions the data.

Scopes: a manifest action's `required_scopes` are Login with CoForge scopes (`openid`, `profile`,
`identity`, `email`), never scopes the app invents ([manifest scopes](https://github.com/lrm-lab/coforge/blob/4b81763cc5b2fe699c7eb5abd0d67e18815ef5cc/docs/agent-manifest/actions.md#scopes)).
`coforge app invoke` asks for a token of exactly those plus the fixed `openid profile identity`, and the service
checks the token's `scope` contains them (403 `insufficient_scope`). Both example actions need nothing beyond the
fixed scopes (`[]`); add `email` only if an action truly needs the person's address, and only if the app is allowed it.
What an Agent may do with its token is the app's own business: this service keeps notes per Workspace.

## Develop

```bash
npm install          # or: bun install
npm test             # unit tests, tokens signed with a local key; manifest checked against the schema
npm start
```

`test/fixtures/coforge-agent-manifest.v1.schema.json` is a vendored copy of [CoForge's published JSON
Schema](https://github.com/lrm-lab/coforge/blob/4b81763cc5b2fe699c7eb5abd0d67e18815ef5cc/docs/agent-manifest/coforge-agent-manifest.v1.schema.json); `test/fixtures/SOURCE.md` records where it came from. Check `GET /.well-known/coforge-agent-manifest.json`
after every manifest change: the test suite does.
