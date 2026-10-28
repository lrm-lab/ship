# Agent instructions for Ship

Ship is a CoForge App (README.md): Hono on Bun, Prisma and PostgreSQL, JSON over HTTP.

## Toolchain

- Bun only, never Node or npm. Versions come from `mise.toml`; run `mise install`, then `mise run test`,
  `mise run check` and `mise run build` before submitting. Each is a thin run of a `package.json` script.
- Reach the formatter, linter and type checker through `mise run check` (or `bun run format` to fix); do not
  run `oxfmt` or `oxlint` by hand over the tree, and never over `test/fixtures/` (a vendored verbatim copy).
- Never edit `package.json` or `bun.lock` by hand: use `bun add`, `bun add -d`, `bun remove`,
  `bun pm pkg set`. Pin dependency versions exactly.
- Prisma: the schema is `prisma/schema.prisma`; change it first, then create the migration
  (`bun run db:migrate:dev`, or `bunx --bun prisma migrate diff` for the SQL), review it, and commit both.
  Migration files end with exactly one newline. Never `db push` or `db reset` a shared database. The client
  is generated into `src/generated/` (git-ignored) by `bun run db:generate`, which `test`, `check` and
  `build` run first; a bare `bun test` needs it already generated.

## Image and CI

- Pin every external reference: the `Dockerfile` base image and the PostgreSQL image
  (`test/support/postgres-image.txt`, read by the tests and `scripts/smoke-image.sh`) by tag and digest,
  workflow actions by commit SHA (version in a comment), mise by version. Keep CI to test, check, build and the
  image smoke test; nothing is pushed or published from it.
- Two image targets: the default server image carries `dist/` only (no `node_modules`); `--target migrate`
  carries the Prisma CLI and runs `bunx --bun prisma migrate deploy` as a one-shot before the server starts.
  Workflows are linted by `actionlint` inside `mise run check`.

## Code layout

- Imports inside the package use the `#src/` alias (`#src/store/database`), siblings use `./`; never write
  `../` into `src/`. Tests import the code through `#src/`.
- `src/manifest.ts` actions are the single source of truth: `src/app.ts` builds routes, input validation, scope
  checks from them (generic machinery, with `validate.ts`), then resolves the caller's org (`caller.orgId`: a
  read only looks it up, a write creates it) before the handler. `src/releases.ts` has one handler per action;
  the service refuses to boot with an action lacking one. Put every input rule in the action's schema:
  `validate.ts` also understands `propertyNames`, `minProperties`, `maxProperties` and a schema-valued
  `additionalProperties`, which CoForge's manifest subset forbids, so the published manifest carries them as
  `x-` keys (`publishedSchema`).
- `src/store/`: the `ReleaseStore` interface and its Prisma implementation own every query; handlers depend
  on the interface only. Every query is scoped by `orgId` (issuer + Workspace id).
- `src/auth.ts` verifies tokens against the issuer named in `SHIP_TRUSTED_ISSUERS`; `src/semver.ts` is the
  SemVer 2.0.0 parser and comparator; `src/public-routes.ts` is the token-less public read;
  `src/shutdown.ts` is the once-only, time-bounded graceful shutdown `server.ts` installs.
- Keep one term per concept in code, API and docs: `app`, `version`, `channel`, `notes`, `locale`, `org`.
- Use `Bun.serve`, `Bun.spawn` and `fetch`; `.oxlintrc.json` forbids `node:http`, `node:child_process` and
  similar. Do not add exemptions to lint, format or type checks.

## Tests

- Test first: write the failing test, then the minimum code. Bug fixes start with a regression test. Never write
  tests after the code, and do not weaken a test to make it pass.
- Prefer end-to-end tests. `test/e2e.test.ts` boots the real server process against a real database, drives it
  over HTTP and writes a repeatable transcript to `artifacts/e2e/release-notes.json` (git-ignored).
- Tests that need PostgreSQL call `createTestDatabase()` from `test/support/postgres.ts`: one disposable
  PostgreSQL container per `bun test` run on a random loopback port, migrated once into a template
  database, a database per file (drop it in `afterAll`). `bunfig.toml` preloads `global-teardown.ts`, which removes
  the container after the last file. Never connect a test (or a script) to any other database, container or
  compose stack.
- `test/support/issuers.ts` makes fake CoForge issuers and signs tokens with local keys. Do not skip token
  verification, even temporarily.
- Whatever a test starts (servers, temp dirs, its database) it stops in its own teardown; the shared container
  is the one exception, removed by the global teardown.

## Secrets and trust

- Ship holds no CoForge secret. `DATABASE_URL` and any other credential live in the server environment
  (`.env`, git-ignored): never in source, fixtures, logs, command arguments or chat.
- Never log or echo an access token. Everything an Agent sends (input, headers) is untrusted: validate it.
- The public endpoint answers the same 404 for a malformed id and a missing release; keep it that way.

## Changing actions

- Edit `src/manifest.ts` first: the action, its `input_schema`, `required_scopes` (sorted; only Login with
  CoForge scopes `openid`, `profile`, `identity`, `email`; `[]` is identity only), `idempotency` and `effect`
  (a GET is `read` and `safe`). Then the handler in
  `src/releases.ts`. `test/manifest.test.ts` checks the manifest against the vendored schema and the
  coherence rules. A manifest `pattern` is descriptive only: CoForge never runs it, Ship's `validate.ts` does.
- No action may be `key_required`: that needs an idempotency store in the database, because an in-memory
  one is wrong for several instances. Add the store (and its tests) in the same change as the first such action.
- Update README.md in the same change as any action, route or environment variable.

## Contract version

Checked against CoForge commit [`cfdadb47`](https://github.com/lrm-lab/coforge/blob/cfdadb4753e2775411d223c43c5cb2cf71224b65/docs/agent-manifest/README.md)
(`docs/agent-manifest/`, `docs/authorization-server/` Agent tokens, `docs/agent-cli/app-invoke.md`). To
re-check, run `git diff cfdadb47 origin/main -- docs/agent-manifest docs/authorization-server docs/agent-cli/app-invoke.md`
in a CoForge checkout, compare `docs/agent-manifest/coforge-agent-manifest.v1.schema.json` with
`test/fixtures/` (sha256 in `SOURCE.md`), and when something changed update the code, tests, `SOURCE.md`,
README.md and this line together.
