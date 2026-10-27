import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "#src/app";
import { publicReleaseUrl } from "#src/public-routes";
import { loadConfig } from "#src/config";
import { createDatabase, type Database } from "#src/store/database";
import { createPrismaReleaseStore } from "#src/store/prisma-release-store";
import { notesPath } from "./support/api";
import {
  createTestIssuer,
  keySetsOf,
  signAgentToken,
  trustedIssuersEnv,
  type TestIssuer,
} from "./support/issuers";
import { createTestDatabase, type TestDatabase } from "./support/postgres";

const BASE = "https://ship.example.com";

let postgres: TestDatabase;
let database: Database;
let app: Hono;
let issuerA: TestIssuer;
let issuerB: TestIssuer;

beforeAll(async () => {
  issuerA = await createTestIssuer("https://a.coforge.example/oidc", "ship-a");
  issuerB = await createTestIssuer("https://b.coforge.example/oidc", "ship-b");
  postgres = await createTestDatabase();
  database = createDatabase(postgres.url);
  const config = loadConfig({
    SHIP_TRUSTED_ISSUERS: trustedIssuersEnv(issuerA, issuerB),
    APP_ORIGIN: BASE,
    DATABASE_URL: postgres.url,
  });
  app = createApp(config, {
    keys: keySetsOf(issuerA, issuerB),
    store: createPrismaReleaseStore(database.client),
  });
}, 120_000);

afterAll(async () => {
  await database?.close();
  await postgres?.drop();
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
  call(notesPath(app, version), {
    method: "PUT",
    body: { notes },
    who,
  });
const getNotes = (app: string, version: string, who?: Who) =>
  call(notesPath(app, version), { who });

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

  test("put and get say where the notes are public: orgId and publicUrl", async () => {
    const put = await (
      await putNotes("where", "1.0.0+build.5", { en: "x" }, { workspace: "w-where" })
    ).json();
    expect(put.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(put.publicUrl).toBe(publicReleaseUrl(BASE, put.orgId, "where", "1.0.0+build.5"));
    const got = await (await getNotes("where", "1.0.0+build.5", { workspace: "w-where" })).json();
    expect(got.orgId).toBe(put.orgId);
    expect(got.publicUrl).toBe(put.publicUrl);
    // the URL works, without a token
    const publicRes = await app.request(put.publicUrl);
    expect(publicRes.status).toBe(200);
    expect((await publicRes.json()).notes).toEqual({ en: "x" });
    // another Workspace gets its own org id
    const other = await (
      await putNotes("where", "1.0.0+build.5", { en: "y" }, { workspace: "w-where-2" })
    ).json();
    expect(other.orgId).not.toBe(put.orgId);
  });

  test("a version without a prerelease part is on the stable channel", async () => {
    const res = await putNotes("chan", "1.2.3+build.5", { en: "x" });
    expect((await res.json()).channel).toBe("stable");
    expect((await (await getNotes("chan", "1.2.3+build.5")).json()).version).toBe("1.2.3+build.5");
  });

  test("reading from a Workspace that has no org creates none; the first write does", async () => {
    const who = { workspace: "w-read-only" };
    const orgs = () => database.client.org.count({ where: { workspaceId: "w-read-only" } });
    expect((await getNotes("fresh", "1.0.0", who)).status).toBe(404);
    const listed = await call("/api/apps/fresh/releases", { who });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ releases: [] });
    expect(await orgs()).toBe(0);
    expect((await putNotes("fresh", "1.0.0", { en: "x" }, who)).status).toBe(200);
    expect(await orgs()).toBe(1);
    expect((await getNotes("fresh", "1.0.0", who)).status).toBe(200);
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

    test("text is limited to 16000 characters as sent, so padding cannot push a text past the limit", async () => {
      const padded = `  ${"x".repeat(16000)}  `;
      const res = await putNotes("limits", "1.0.0", { en: padded });
      expect(res.status).toBe(400);
      expect((await res.json()).problems[0]).toContain("notes.en");
    });

    test("accepts text of exactly 16000 characters, and 20 locales", async () => {
      const exact = "x".repeat(16000);
      const twenty = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`b${String.fromCharCode(97 + i)}`, "x"]),
      );
      expect((await putNotes("limits", "1.0.0", { en: exact })).status).toBe(200);
      expect((await putNotes("limits", "1.0.1", twenty)).status).toBe(200);
    });

    test("accepts the largest allowed notes: 20 locales of 16000 characters, in ASCII or CJK", async () => {
      const locales = Array.from({ length: 20 }, (_, i) => `c${String.fromCharCode(97 + i)}`);
      const ascii = Object.fromEntries(
        locales.map((l) => [l, "line of text\n".repeat(1230).slice(0, 16000)]),
      );
      const cjk = Object.fromEntries(locales.map((l) => [l, "重".repeat(16000)]));
      expect((await putNotes("biggest", "1.0.0", ascii)).status).toBe(200);
      const res = await putNotes("biggest", "1.0.1", cjk);
      expect(res.status).toBe(200);
      expect(
        Object.values((await res.json()).notes).every((text) => (text as string).length === 16000),
      ).toBe(true);
    });

    test("accepts the largest allowed notes even as a body of \\uXXXX and \\n escapes (6 bytes a character)", async () => {
      const locales = Array.from({ length: 20 }, (_, i) => `d${String.fromCharCode(97 + i)}`);
      const notes = Object.fromEntries(locales.map((l) => [l, "重".repeat(16000)]));
      // JSON.stringify keeps 重 as one character; escape it the way another client may send it
      const body = JSON.stringify({ notes }).replace(
        /[^\x00-\x7f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      expect(body.length).toBeGreaterThan(1024 * 1024);
      const res = await app.request(`${BASE}${notesPath("escaped", "1.0.0")}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await bearerFor()}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(res.status).toBe(200);
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
    await putNotes("shape-other", "9.0.0", { en: "another app of the same org" });
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
  const who = { workspace: "w-pub" };
  /** Publishes as the Workspace and returns the org id the response names. */
  const publish = async (
    appName: string,
    version: string,
    notes: Record<string, string>,
    as: Who = who,
  ) => (await (await putNotes(appName, version, notes, as)).json()).orgId as string;
  const publicGet = (orgId: string, appName: string, version: string) =>
    app.request(publicReleaseUrl(BASE, orgId, appName, version));

  test("serves the notes without a token, with cache-control: no-cache", async () => {
    const orgId = await publish("public-demo", "2.1.0-dev.3", { en: "Hello", "zh-CN": "你好" });
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
    const orgId = await publish("public-same", "1.0.0", { en: "a", fr: "b" });
    const viaAction = await (await getNotes("public-same", "1.0.0", who)).json();
    const { orgId: actionOrgId, publicUrl, ...rest } = viaAction;
    expect(actionOrgId).toBe(orgId);
    expect(publicUrl).toBe(publicReleaseUrl(BASE, orgId, "public-same", "1.0.0"));
    expect(await (await publicGet(orgId, "public-same", "1.0.0")).json()).toEqual(rest);
    await putNotes("public-same", "1.0.0", { en: "c" }, who);
    expect((await (await publicGet(orgId, "public-same", "1.0.0")).json()).notes).toEqual({
      en: "c",
    });
  });

  test("404 not_found, one body, for an unknown release, another org's id, or any malformed part", async () => {
    const orgId = await publish("public-404", "1.0.0", { en: "x" });
    const otherOrg = await publish(
      "elsewhere",
      "1.0.0",
      { en: "y" },
      { issuer: issuerB, workspace: "w-pub" },
    );
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
    const responses = await Promise.all(urls.map(([o, a, v]) => publicGet(o, a, v)));
    // paths that do not match the route at all, and other methods, answer the same
    const unmatched = [
      app.request(`${BASE}/public/v1/orgs/${orgId}/apps/public-404/releases`),
      app.request(`${BASE}/public/v1/orgs/${orgId}`),
      app.request(`${BASE}/public/nothing`),
      app.request(publicReleaseUrl(BASE, orgId, "public-404", "1.0.0"), { method: "DELETE" }),
    ];
    responses.push(...(await Promise.all(unmatched)));
    const bodies = [];
    for (const res of responses) {
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
    const orgId = await publish("public-auth", "1.0.0", { en: "x" });
    const res = await app.request(publicReleaseUrl(BASE, orgId, "public-auth", "1.0.0"), {
      headers: { authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(200);
  });
});
