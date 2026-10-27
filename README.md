# Ship

Ship is a release-notes service that runs as a [CoForge](https://github.com/lrm-lab/coforge) App. An
Agent publishes the notes of an app version, one Markdown text per locale, and lists an app's
releases; CoForge Web reads them at a public endpoint to show "What's new". Ship runs on
[Bun](https://bun.sh) with [Hono](https://hono.dev), stores its data in PostgreSQL through
[Prisma](https://www.prisma.io), and verifies the Agent access tokens of **several** CoForge
deployments (each registers Ship as its own App with its own client ID).

## What it serves

| Route                                                       | Auth   | Does                                                                                   |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `GET /.well-known/coforge-agent-manifest.json`              | none   | The `coforge-agent-manifest.v1` document, built from the actions in `src/manifest.ts`. |
| `PUT /api/apps/{app}/releases/{version}/notes`              | Bearer | Action `releases.notes.put` (effect `update`, idempotency `idempotent`).               |
| `GET /api/apps/{app}/releases/{version}/notes`              | Bearer | Action `releases.notes.get` (effect `read`, `safe`).                                   |
| `GET /api/apps/{app}/releases`                              | Bearer | Action `releases.list` (effect `read`, `safe`).                                        |
| `GET /public/v1/orgs/{orgId}/apps/{app}/releases/{version}` | none   | The public read, not in the manifest.                                                  |
| `GET /healthz`                                              | none   | Liveness.                                                                              |

No action needs a scope beyond the fixed `openid profile identity` (`required_scopes: []`).

### Actions

| Action               | Input                                                                                                                                                                                                     | Result                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases.notes.put` | `app`, `version`, `notes`: an object of locale to Markdown. 1 to 20 locales, a locale matches `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, each text trimmed and 1 to 16000 characters (JavaScript string length). | 200 `{ app, version, channel, notes, updatedAt, orgId, publicUrl }`. Replaces the version's whole set of notes: locales not sent are removed. |
| `releases.notes.get` | `app`, `version`                                                                                                                                                                                          | 200 as above (with `orgId` and `publicUrl`), or 404 `not_found`.                                                                              |
| `releases.list`      | `app`, optional `channel` (`dev` or `stable`), `limit` (1 to 100, default 20)                                                                                                                             | 200 `{ releases: [{ version, channel, locales, updatedAt }] }`, newest first by SemVer precedence, not by time.                               |

`app` matches `^[a-z0-9][a-z0-9-]{0,62}$`. `version` is a [SemVer 2.0.0](https://semver.org/) string
(`src/semver.ts`); a version with a prerelease part (`0.1.3-dev.4`) is on the `dev` channel, any other on
`stable`. Versions that differ only in build metadata have equal precedence and are listed in descending
text order.

Errors are JSON `{ error, message }`: 400 `invalid_input` (with `problems`), 401 `unauthorized` or
`invalid_token`, 403 `insufficient_scope`, 404 `not_found`, 413 `payload_too_large` (a body over 1 MiB).

### Data is scoped by org

Everything belongs to an org: one Workspace of one CoForge issuer, created on that Workspace's first
authenticated call. Another Workspace, or the same Workspace id under another issuer, never sees it.

### Public read

`GET /public/v1/orgs/{orgId}/apps/{app}/releases/{version}` needs no token and answers 200
`{ app, version, channel, notes, updatedAt }` with `cache-control: no-cache`, or 404 `not_found`. A malformed
org id, app or version gets the same 404 as a release that does not exist. The org id is the id of the org
(`orgs.id`), not a secret: anyone who knows it can read what that org published. `releases.notes.put` and
`releases.notes.get` return it as `orgId`, with the ready URL as `publicUrl`
(`APP_ORIGIN/public/v1/orgs/{orgId}/apps/{app}/releases/{version}`, the version percent-encoded); the public
body itself has neither.

## Environment variables

Copy `.env.example` to `.env` (Bun loads it).

| Variable               | Meaning                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SHIP_TRUSTED_ISSUERS` | JSON array of `{ "issuer": "https://coforge.cn/oidc", "clientId": "..." }`: non-empty, issuers unique, https (http only for localhost), no trailing slash. Keys come from `<issuer>/jwks`. |
| `APP_ORIGIN`           | The public https origin of Ship (`https://ship.coforge.cn`). The manifest's `execution.base_url` is `APP_ORIGIN/api`.                                                                      |
| `DATABASE_URL`         | PostgreSQL connection string.                                                                                                                                                              |
| `PORT`                 | Listen port, default 3000.                                                                                                                                                                 |
| `HOST`                 | Interface to listen on, default `0.0.0.0`.                                                                                                                                                 |

Ship holds no CoForge client secret: it only verifies tokens.

## Tokens

An Agent token is an RFC 9068 JWT: ES256, header `typ: at+jwt`, valid five minutes
([claims](https://github.com/lrm-lab/coforge/blob/cfdadb4753e2775411d223c43c5cb2cf71224b65/docs/authorization-server/README.md#agent-tokens)).
Ship reads the token's `iss` without trusting it, looks it up in `SHIP_TRUSTED_ISSUERS` (unknown: 401
`invalid_token`), then verifies the token against that issuer alone: signature by `kid` against its
`<issuer>/jwks`, `typ`, `iss`, `aud` equal to that entry's client ID, `exp`, `type: "agent"` and a
`workspace_id`. A token issued by B that carries A's client ID is refused. The caller is
`{ issuer, workspaceId, agentId, scopes }`.

## Register Ship in CoForge

On each CoForge deployment: a Workspace owner or admin opens Settings -> Applications and registers Ship
with the homepage `https://ship.coforge.cn` (the Agent CLI accepts `base_url` only on the origin of the
homepage or the manifest URL, and requires https). Put the client ID that deployment gives Ship into
`SHIP_TRUSTED_ISSUERS` next to its issuer (production `https://coforge.cn/oidc`, staging
`https://staging.coforge.cn/oidc`). Then an Agent can call:

```bash
coforge app invoke <app-key> --list-actions
coforge app invoke <app-key> releases.notes.put --data-json '{"app":"coforge-computer","version":"0.1.3-dev.4","notes":{"en":"Faster restarts.","zh-CN":"重启更快。"}}'
coforge app invoke <app-key> releases.notes.get --param app=coforge-computer --param version=0.1.3-dev.4
coforge app invoke <app-key> releases.list --param app=coforge-computer --param channel=dev
```

## Develop and test

Tools come from `mise.toml` (Bun 1.4.4); Docker is needed for the tests.

```bash
mise install
bun install
mise run test      # bun test; generates the Prisma client first
mise run check     # oxfmt --check, oxlint, tsc --noEmit
mise run build     # bun build ./src/server.ts --target bun --outdir dist
bun run start      # needs .env and a migrated database: bun run db:migrate:deploy
```

The tests start their own disposable PostgreSQL (`postgres:17-alpine`, a random loopback port), apply
`prisma/migrations` with `prisma migrate deploy`, and remove the container afterwards. They never use another
database. `test/e2e.test.ts` boots the real server against it with two fake issuers and writes the transcript
`artifacts/e2e/release-notes.json` (git-ignored).

`test/fixtures/coforge-agent-manifest.v1.schema.json` is a vendored copy of CoForge's published JSON Schema;
`test/fixtures/SOURCE.md` records where it came from.
