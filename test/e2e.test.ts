import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { publicReleaseUrl } from "#src/public-routes";
import { notesPath } from "./support/api";
import {
  createTestIssuer,
  signAgentToken,
  trustedIssuersEnv,
  type TestIssuer,
} from "./support/issuers";
import { createTestDatabase, type TestDatabase } from "./support/postgres";

/**
 * End to end: the real server process (`bun src/server.ts`) against a disposable PostgreSQL, with
 * two fake CoForge issuers that serve /jwks, driven over HTTP. The requests and answers, without
 * tokens, are written to artifacts/e2e/release-notes.json.
 */

const root = new URL("..", import.meta.url).pathname;
const ARTIFACT_DIR = `${root}artifacts/e2e`;

type Fake = { issuer: TestIssuer; server: ReturnType<typeof Bun.serve> };
const fakes: Fake[] = [];

async function startFakeIssuer(clientId: string): Promise<Fake> {
  // The issuer URL carries the port, which is only known once the server listens.
  let jwks: unknown = { keys: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/jwks"
        ? Response.json(jwks)
        : new Response("not found", { status: 404 }),
  });
  const issuer = await createTestIssuer(`http://127.0.0.1:${server.port}`, clientId);
  jwks = issuer.jwks;
  const fake = { issuer, server };
  fakes.push(fake);
  return fake;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  return port as number;
}

let postgres: TestDatabase;
let sql: SQL;
let child: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
let issuerA: TestIssuer;
let issuerB: TestIssuer;
let untrusted: TestIssuer;
let orgId = "";
let publicUrl = "";
let stderrText = Promise.resolve("");

type Step = {
  name: string;
  caller: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; body: unknown };
};
const transcript: Step[] = [];

/** Who calls: a label for the artifact, and how to mint the token (never written out). */
type As = { label: string; token: () => Promise<string> } | null;
const agent = (
  issuer: () => TestIssuer,
  workspace: string,
  agentId: string,
  label: string,
): As => ({
  label,
  token: () => signAgentToken(issuer(), { sub: agentId, claims: { workspace_id: workspace } }),
});
const asA = agent(() => issuerA, "w1", "agent-1", "agent-1 of issuer A, Workspace w1");
const asB = agent(() => issuerB, "w1", "agent-9", "agent-9 of issuer B, Workspace w1");

/** One call over real HTTP; the request (without its token) and the answer are kept for the artifact. */
async function step(name: string, caller: As, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (caller) headers.authorization = `Bearer ${await caller.token()}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the text
  }
  transcript.push({
    name,
    caller: caller?.label ?? "no token",
    request: { method, path, ...(body === undefined ? {} : { body }) },
    response: { status: res.status, body: parsed },
  });
  return { status: res.status, body: parsed as any, headers: res.headers };
}

beforeAll(async () => {
  [{ issuer: issuerA }, { issuer: issuerB }, { issuer: untrusted }] = await Promise.all([
    startFakeIssuer("ship-a"),
    startFakeIssuer("ship-b"),
    startFakeIssuer("ship-untrusted"),
  ]);
  postgres = await createTestDatabase();
  sql = new SQL(postgres.url);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      SHIP_TRUSTED_ISSUERS: trustedIssuersEnv(issuerA, issuerB),
      APP_ORIGIN: base,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: postgres.url,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  stderrText = new Response(child.stderr as ReadableStream).text();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) throw new Error(`The server exited early: ${await stderrText}`);
    if (Date.now() > deadline) throw new Error("The server did not start");
    await Bun.sleep(100);
  }
}, 180_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  await sql?.close().catch(() => {});
  for (const { server } of fakes) await server.stop(true);
  await postgres?.drop();
  if (transcript.length > 0) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(
      `${ARTIFACT_DIR}/release-notes.json`,
      `${JSON.stringify(normalize(transcript), null, 2)}\n`,
    );
  }
});

/** Replaces what differs from run to run (ports, timestamps, generated ids) so the artifact repeats. */
function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "<timestamp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<org-id>");
  return JSON.parse(text);
}

const versionsOf = (body: { releases: { version: string }[] }) =>
  body.releases.map((r) => r.version);

describe("Ship end to end", () => {
  test("publishes the manifest without a token", async () => {
    const res = await step("manifest", null, "GET", "/.well-known/coforge-agent-manifest.json");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Ship");
    expect(res.body.execution.base_url).toBe(`${base}/api`);
    expect(res.body.actions.map((a: { name: string }) => a.name)).toEqual([
      "releases.notes.put",
      "releases.notes.get",
      "releases.list",
    ]);
  });

  test("an Agent of issuer A puts notes and reads them back", async () => {
    const put = await step(
      "put 0.1.3-dev.4",
      asA,
      "PUT",
      notesPath("coforge-computer", "0.1.3-dev.4"),
      {
        notes: { en: "Faster restarts.", "zh-CN": "重启更快。" },
      },
    );
    expect(put.status).toBe(200);
    // the response says where the notes are public; the public test below reads that location
    orgId = put.body.orgId;
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
    publicUrl = put.body.publicUrl;
    expect(publicUrl).toBe(
      `${base}/public/v1/orgs/${orgId}/apps/coforge-computer/releases/${encodeURIComponent("0.1.3-dev.4")}`,
    );
    expect(put.body).toMatchObject({
      app: "coforge-computer",
      version: "0.1.3-dev.4",
      channel: "dev",
      notes: { en: "Faster restarts.", "zh-CN": "重启更快。" },
    });
    const got = await step(
      "get 0.1.3-dev.4",
      asA,
      "GET",
      notesPath("coforge-computer", "0.1.3-dev.4"),
    );
    expect(got.status).toBe(200);
    expect(got.body).toEqual(put.body);
    const missing = await step(
      "get an unknown version",
      asA,
      "GET",
      notesPath("coforge-computer", "9.9.9"),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  test("lists releases newest first by SemVer precedence, with their channels", async () => {
    for (const version of ["0.1.10", "0.1.3", "0.1.3-dev.10", "0.1.9", "0.1.3-dev.9"]) {
      const res = await step(`put ${version}`, asA, "PUT", notesPath("coforge-computer", version), {
        notes: { en: `Notes for ${version}` },
      });
      expect(res.status).toBe(200);
    }
    const all = await step("list", asA, "GET", "/api/apps/coforge-computer/releases");
    expect(versionsOf(all.body)).toEqual([
      "0.1.10",
      "0.1.9",
      "0.1.3",
      "0.1.3-dev.10",
      "0.1.3-dev.9",
      "0.1.3-dev.4",
    ]);
    expect(all.body.releases.map((r: { channel: string }) => r.channel)).toEqual([
      "stable",
      "stable",
      "stable",
      "dev",
      "dev",
      "dev",
    ]);
    const dev = await step(
      "list dev",
      asA,
      "GET",
      "/api/apps/coforge-computer/releases?channel=dev&limit=2",
    );
    expect(versionsOf(dev.body)).toEqual(["0.1.3-dev.10", "0.1.3-dev.9"]);
    const stable = await step(
      "list stable",
      asA,
      "GET",
      "/api/apps/coforge-computer/releases?channel=stable",
    );
    expect(versionsOf(stable.body)).toEqual(["0.1.10", "0.1.9", "0.1.3"]);
  });

  test("a second put replaces the notes: a locale left out is removed", async () => {
    const put = await step(
      "overwrite 0.1.3-dev.4",
      asA,
      "PUT",
      notesPath("coforge-computer", "0.1.3-dev.4"),
      {
        notes: { en: "Faster restarts and a calmer upgrade." },
      },
    );
    expect(put.body.notes).toEqual({ en: "Faster restarts and a calmer upgrade." });
    const got = await step(
      "get after overwrite",
      asA,
      "GET",
      notesPath("coforge-computer", "0.1.3-dev.4"),
    );
    expect(Object.keys(got.body.notes)).toEqual(["en"]);
  });

  test("anyone can read a release by org id at the public endpoint", async () => {
    const location = new URL(publicUrl);
    expect(location.origin).toBe(base);
    const res = await step("public read", null, "GET", location.pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.body).toMatchObject({
      app: "coforge-computer",
      version: "0.1.3-dev.4",
      channel: "dev",
      notes: { en: "Faster restarts and a calmer upgrade." },
    });
    const unknown = await step(
      "public read of an unknown version",
      null,
      "GET",
      new URL(publicReleaseUrl(base, orgId, "coforge-computer", "7.7.7")).pathname,
    );
    expect(unknown.status).toBe(404);
  });

  test("an Agent of issuer B with the same Workspace id sees none of it", async () => {
    const get = await step(
      "issuer B gets A's version",
      asB,
      "GET",
      notesPath("coforge-computer", "0.1.3-dev.4"),
    );
    expect(get.status).toBe(404);
    const list = await step(
      "issuer B lists A's app",
      asB,
      "GET",
      "/api/apps/coforge-computer/releases",
    );
    expect(list.body).toEqual({ releases: [] });
    const put = await step(
      "issuer B puts its own notes",
      asB,
      "PUT",
      notesPath("coforge-computer", "0.1.3-dev.4"),
      {
        notes: { en: "B's notes" },
      },
    );
    expect(put.status).toBe(200);
    const stillA = await step(
      "A's notes are unchanged",
      asA,
      "GET",
      notesPath("coforge-computer", "0.1.3-dev.4"),
    );
    expect(stillA.body.notes).toEqual({ en: "Faster restarts and a calmer upgrade." });
    const orgs = await sql`select count(*)::int as n from orgs where workspace_id = 'w1'`;
    expect(orgs[0]?.n).toBe(2);
  });

  test("a token from an issuer Ship does not trust, or forged for one it does, is refused", async () => {
    const stranger = agent(() => untrusted, "w1", "agent-x", "agent-x of an untrusted issuer");
    const res = await step(
      "untrusted issuer",
      stranger,
      "GET",
      "/api/apps/coforge-computer/releases",
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    // right issuer and client ID of A, but signed with B's key
    const imposter: As = {
      label: "a token naming issuer A, signed with issuer B's key",
      token: () => signAgentToken(issuerB, { iss: issuerA.issuer, aud: issuerA.clientId }),
    };
    const forged = await step(
      "forged for issuer A",
      imposter,
      "GET",
      "/api/apps/coforge-computer/releases",
    );
    expect(forged.status).toBe(401);
  });
});
