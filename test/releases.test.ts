import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "#src/app";
import { loadConfig } from "#src/config";
import { createDatabase, type Database } from "#src/store/database";
import { createPrismaReleaseStore } from "#src/store/prisma-release-store";
import { createTestIssuer, signAgentToken, type TestIssuer } from "./support/issuers";
import { startDisposablePostgres, type DisposablePostgres } from "./support/postgres";

const BASE = "https://ship.example.com";

let postgres: DisposablePostgres;
let database: Database;
let app: Hono;
let issuerA: TestIssuer;
let issuerB: TestIssuer;

beforeAll(async () => {
  issuerA = await createTestIssuer("https://a.coforge.example/oidc", "ship-a");
  issuerB = await createTestIssuer("https://b.coforge.example/oidc", "ship-b");
  postgres = await startDisposablePostgres();
  database = createDatabase(postgres.url);
  const config = loadConfig({
    SHIP_TRUSTED_ISSUERS: JSON.stringify([
      { issuer: issuerA.issuer, clientId: issuerA.clientId },
      { issuer: issuerB.issuer, clientId: issuerB.clientId },
    ]),
    APP_ORIGIN: BASE,
    DATABASE_URL: postgres.url,
  });
  app = createApp(config, {
    keys: { [issuerA.issuer]: issuerA.keySet, [issuerB.issuer]: issuerB.keySet },
    store: createPrismaReleaseStore(database.client),
  });
}, 120_000);

afterAll(async () => {
  await database?.close();
  await postgres?.stop();
});

type Who = { issuer?: TestIssuer; workspace?: string; agent?: string };
const bearerFor = ({ issuer = issuerA, workspace = "w1", agent = "agent-1" }: Who = {}) =>
  signAgentToken(issuer, { sub: agent, claims: { workspace_id: workspace } });

async function call(
  path: string,
  { method = "GET", who, body }: { method?: string; who?: Who | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (who !== null) headers.authorization = `Bearer ${await bearerFor(who)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const putNotes = (app: string, version: string, notes: unknown, who?: Who) =>
  call(`/api/apps/${app}/releases/${encodeURIComponent(version)}/notes`, {
    method: "PUT",
    body: { notes },
    who,
  });
const getNotes = (app: string, version: string, who?: Who) =>
  call(`/api/apps/${app}/releases/${encodeURIComponent(version)}/notes`, { who });

describe("releases.notes.put and releases.notes.get", () => {
  test("puts the notes of a version, then reads them back", async () => {
    const put = await putNotes("coforge-computer", "0.1.3-dev.4", {
      en: "  Faster restarts.  ",
      "zh-CN": "重启更快。",
    });
    expect(put.status).toBe(200);
    const stored = await put.json();
    expect(stored).toMatchObject({
      app: "coforge-computer",
      version: "0.1.3-dev.4",
      channel: "dev",
      notes: { en: "Faster restarts.", "zh-CN": "重启更快。" },
    });
    expect(new Date(stored.updatedAt).toISOString()).toBe(stored.updatedAt);

    const got = await getNotes("coforge-computer", "0.1.3-dev.4");
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(stored);
  });

  test("a version without a prerelease part is on the stable channel", async () => {
    const res = await putNotes("chan", "1.2.3+build.5", { en: "x" });
    expect((await res.json()).channel).toBe("stable");
    expect((await (await getNotes("chan", "1.2.3+build.5")).json()).version).toBe("1.2.3+build.5");
  });

  test("a second put replaces the whole set: locales not sent are removed", async () => {
    await putNotes("overwrite", "1.0.0", { en: "one", fr: "un", de: "eins" });
    const second = await putNotes("overwrite", "1.0.0", { en: "uno" }, { agent: "agent-2" });
    expect((await second.json()).notes).toEqual({ en: "uno" });
    expect((await (await getNotes("overwrite", "1.0.0")).json()).notes).toEqual({ en: "uno" });
  });

  test("get of an unknown version or app is 404 not_found", async () => {
    const res = await getNotes("overwrite", "9.9.9");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect((await getNotes("never-seen", "1.0.0")).status).toBe(404);
  });

  test("another Workspace, or the same Workspace id under another issuer, sees nothing", async () => {
    await putNotes("private", "1.0.0", { en: "secret" });
    expect((await getNotes("private", "1.0.0", { workspace: "w2" })).status).toBe(404);
    expect((await getNotes("private", "1.0.0", { issuer: issuerB })).status).toBe(404);
    expect((await getNotes("private", "1.0.0", { issuer: issuerB, workspace: "w1" })).status).toBe(
      404,
    );
    expect((await getNotes("private", "1.0.0")).status).toBe(200);
    // and a write from there does not touch the first org's notes
    await putNotes("private", "1.0.0", { en: "other" }, { issuer: issuerB });
    expect((await (await getNotes("private", "1.0.0")).json()).notes).toEqual({ en: "secret" });
  });

  test("requires a token", async () => {
    const res = await call("/api/apps/private/releases/1.0.0/notes", { who: null });
    expect(res.status).toBe(401);
  });

  describe("input validation (400 invalid_input)", () => {
    const long = "x".repeat(16001);
    const twentyOne = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`a${String.fromCharCode(97 + i)}`, "x"]),
    );
    const cases: [string, string, string, unknown][] = [
      ["an app with a capital", "Demo", "1.0.0", { en: "x" }],
      ["an app that starts with a dash", "-demo", "1.0.0", { en: "x" }],
      ["an app longer than 63 characters", "a".repeat(64), "1.0.0", { en: "x" }],
      ["a version that is not SemVer", "demo", "1.0", { en: "x" }],
      ["a version with a leading v", "demo", "v1.0.0", { en: "x" }],
      ["a version with leading zeros", "demo", "01.0.0", { en: "x" }],
      ["no locales", "demo", "1.0.0", {}],
      ["more than 20 locales", "demo", "1.0.0", twentyOne],
      ["a locale in upper case", "demo", "1.0.0", { EN: "x" }],
      ["a locale with an underscore", "demo", "1.0.0", { zh_CN: "x" }],
      ["a one-letter locale", "demo", "1.0.0", { e: "x" }],
      ["blank text", "demo", "1.0.0", { en: "   \n " }],
      ["empty text", "demo", "1.0.0", { en: "" }],
      ["text over 16000 characters", "demo", "1.0.0", { en: long }],
      ["text that is not a string", "demo", "1.0.0", { en: 5 }],
      ["notes that is an array", "demo", "1.0.0", ["x"]],
      ["notes that is a string", "demo", "1.0.0", "x"],
      ["notes that is null", "demo", "1.0.0", null],
    ];
    for (const [name, appName, version, notes] of cases) {
      test(`rejects ${name}`, async () => {
        const res = await putNotes(appName, version, notes);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("invalid_input");
      });
    }

    test("accepts text of exactly 16000 characters after trimming, and 20 locales", async () => {
      const exact = `  ${"x".repeat(16000)}  `;
      const twenty = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`b${String.fromCharCode(97 + i)}`, "x"]),
      );
      expect((await putNotes("limits", "1.0.0", { en: exact })).status).toBe(200);
      expect((await putNotes("limits", "1.0.1", twenty)).status).toBe(200);
    });

    test("accepts locale tags with a script or region", async () => {
      const res = await putNotes("locales", "1.0.0", {
        en: "a",
        "zh-Hans-CN": "b",
        fil: "c",
        "es-419": "d",
      });
      expect(res.status).toBe(200);
    });

    test("the notes are required and nothing else is allowed in the body", async () => {
      const path = "/api/apps/demo/releases/1.0.0/notes";
      expect((await call(path, { method: "PUT", body: {} })).status).toBe(400);
      expect(
        (await call(path, { method: "PUT", body: { notes: { en: "x" }, extra: 1 } })).status,
      ).toBe(400);
    });
  });
});

describe("releases.list", () => {
  const seed = async (app: string, versions: string[], who?: Who) => {
    for (const version of versions) await putNotes(app, version, { en: `notes ${version}` }, who);
  };
  const list = async (app: string, query = "", who?: Who) => {
    const res = await call(`/api/apps/${app}/releases${query}`, { who });
    return { status: res.status, body: await res.json() };
  };

  test("newest first by SemVer precedence, not by time", async () => {
    // written out of order, so insertion order and updatedAt both disagree with SemVer
    await seed("ordering", [
      "0.1.10",
      "0.1.3-dev.10",
      "0.1.9",
      "0.1.3-dev.9",
      "0.2.0-dev.1",
      "0.1.3",
      "0.0.9",
      "0.2.0",
    ]);
    const { status, body } = await list("ordering");
    expect(status).toBe(200);
    expect(body.releases.map((r: { version: string }) => r.version)).toEqual([
      "0.2.0",
      "0.2.0-dev.1",
      "0.1.10",
      "0.1.9",
      "0.1.3",
      "0.1.3-dev.10",
      "0.1.3-dev.9",
      "0.0.9",
    ]);
  });

  test("each entry has the version, channel, locales and updatedAt", async () => {
    await putNotes("shape", "1.0.0", { en: "a", "zh-CN": "b" });
    await putNotes("shape", "1.1.0-dev.1", { en: "c" });
    const { body } = await list("shape");
    expect(body.releases).toEqual([
      { version: "1.1.0-dev.1", channel: "dev", locales: ["en"], updatedAt: expect.any(String) },
      {
        version: "1.0.0",
        channel: "stable",
        locales: ["en", "zh-CN"],
        updatedAt: expect.any(String),
      },
    ]);
  });

  test("filters by channel", async () => {
    await seed("channels", ["1.0.0", "1.1.0-dev.1", "1.1.0-dev.2", "1.1.0"]);
    const dev = await list("channels", "?channel=dev");
    expect(dev.body.releases.map((r: { version: string }) => r.version)).toEqual([
      "1.1.0-dev.2",
      "1.1.0-dev.1",
    ]);
    const stable = await list("channels", "?channel=stable");
    expect(stable.body.releases.map((r: { version: string }) => r.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
  });

  test("limit defaults to 20 and is capped at 100", async () => {
    await seed(
      "many",
      Array.from({ length: 25 }, (_, i) => `1.0.${i}`),
    );
    expect((await list("many")).body.releases).toHaveLength(20);
    expect((await list("many")).body.releases[0].version).toBe("1.0.24");
    const three = await list("many", "?limit=3");
    expect(three.body.releases.map((r: { version: string }) => r.version)).toEqual([
      "1.0.24",
      "1.0.23",
      "1.0.22",
    ]);
    expect((await list("many", "?limit=100")).body.releases).toHaveLength(25);
  });

  test("rejects a bad channel or limit, and an unknown parameter", async () => {
    for (const query of [
      "?channel=beta",
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?limit=1.5",
      "?extra=1",
    ]) {
      expect((await list("many", query)).status).toBe(400);
    }
    expect((await list("Bad_App")).status).toBe(400);
  });

  test("an unknown app lists nothing, and other orgs' releases are not listed", async () => {
    expect((await list("nothing-here")).body).toEqual({ releases: [] });
    await seed("shared-name", ["1.0.0"], { workspace: "w-other" });
    expect((await list("shared-name")).body).toEqual({ releases: [] });
    expect(
      (await list("shared-name", "", { issuer: issuerB, workspace: "w-other" })).body.releases,
    ).toEqual([]);
    expect((await list("shared-name", "", { workspace: "w-other" })).body.releases).toHaveLength(1);
  });
});

describe("public read: GET /public/v1/orgs/{orgId}/apps/{app}/releases/{version}", () => {
  /** The org id a Workspace got, found through the store the app uses. */
  const orgIdOf = (issuer: TestIssuer, workspaceId: string) =>
    createPrismaReleaseStore(database.client).ensureOrg({ issuer: issuer.issuer, workspaceId });
  const publicGet = (orgId: string, appName: string, version: string) =>
    app.request(
      `${BASE}/public/v1/orgs/${orgId}/apps/${appName}/releases/${encodeURIComponent(version)}`,
    );

  test("serves the notes without a token, with cache-control: no-cache", async () => {
    await putNotes(
      "public-demo",
      "2.1.0-dev.3",
      { en: "Hello", "zh-CN": "你好" },
      { workspace: "w-pub" },
    );
    const orgId = await orgIdOf(issuerA, "w-pub");
    const res = await publicGet(orgId, "public-demo", "2.1.0-dev.3");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual({
      app: "public-demo",
      version: "2.1.0-dev.3",
      channel: "dev",
      notes: { en: "Hello", "zh-CN": "你好" },
      updatedAt: expect.any(String),
    });
  });

  test("shows the same body as releases.notes.get and follows an overwrite", async () => {
    await putNotes("public-same", "1.0.0", { en: "a", fr: "b" }, { workspace: "w-pub" });
    const orgId = await orgIdOf(issuerA, "w-pub");
    const viaAction = await (await getNotes("public-same", "1.0.0", { workspace: "w-pub" })).json();
    expect(await (await publicGet(orgId, "public-same", "1.0.0")).json()).toEqual(viaAction);
    await putNotes("public-same", "1.0.0", { en: "c" }, { workspace: "w-pub" });
    expect((await (await publicGet(orgId, "public-same", "1.0.0")).json()).notes).toEqual({
      en: "c",
    });
  });

  test("404 not_found for an unknown release, another org's id, or any malformed part", async () => {
    await putNotes("public-404", "1.0.0", { en: "x" }, { workspace: "w-pub" });
    const orgId = await orgIdOf(issuerA, "w-pub");
    const otherOrg = await orgIdOf(issuerB, "w-pub");
    const urls = [
      [orgId, "public-404", "9.9.9"],
      [orgId, "no-such-app", "1.0.0"],
      [otherOrg, "public-404", "1.0.0"],
      ["0199a8c0-0000-7000-8000-000000000000", "public-404", "1.0.0"],
      ["not-a-uuid", "public-404", "1.0.0"],
      [orgId, "Bad_App", "1.0.0"],
      [orgId, "public-404", "1.0"],
      [orgId, "public-404", "v1.0.0"],
    ] as const;
    const bodies = [];
    for (const [o, a, v] of urls) {
      const res = await publicGet(o, a, v);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      bodies.push(await res.json());
    }
    // the answer does not say which part was wrong
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0].error).toBe("not_found");
  });

  test("is not part of the manifest and ignores an Authorization header", async () => {
    const manifest = await (
      await app.request(`${BASE}/.well-known/coforge-agent-manifest.json`)
    ).json();
    expect(JSON.stringify(manifest)).not.toContain("/public/");
    const orgId = await orgIdOf(issuerA, "w-pub");
    const res = await app.request(
      `${BASE}/public/v1/orgs/${orgId}/apps/public-same/releases/1.0.0`,
      { headers: { authorization: "Bearer garbage" } },
    );
    expect(res.status).toBe(200);
  });
});
