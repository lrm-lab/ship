import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "#src/store/database";
import { createPrismaReleaseStore } from "#src/store/prisma-release-store";
import type { ReleaseStore } from "#src/store/release-store";
import { startDisposablePostgres, type DisposablePostgres } from "./support/postgres";

let postgres: DisposablePostgres;
let database: Database;
let store: ReleaseStore;

beforeAll(async () => {
  postgres = await startDisposablePostgres();
  database = createDatabase(postgres.url);
  store = createPrismaReleaseStore(database.client);
}, 120_000);

afterAll(async () => {
  await database?.close();
  await postgres?.stop();
});

const put = (orgId: string, version: string, notes: Record<string, string>, agentId = "agent-1") =>
  store.putNotes({
    orgId,
    app: "demo",
    version,
    channel: version.includes("-") ? "dev" : "stable",
    agentId,
    notes,
  });

describe("orgs", () => {
  test("an org is created once per issuer and Workspace", async () => {
    const first = await store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-org" });
    const again = await store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-org" });
    expect(again).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("the same Workspace id under another issuer is another org", async () => {
    const a = await store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-same" });
    const b = await store.ensureOrg({ issuer: "https://b.example/oidc", workspaceId: "w-same" });
    const other = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-other",
    });
    expect(new Set([a, b, other]).size).toBe(3);
  });

  test("a later call for an existing org does not write to it", async () => {
    const key = { issuer: "https://a.example/oidc", workspaceId: "w-readonly" };
    const orgId = await store.ensureOrg(key);
    const before = await database.client.org.findUniqueOrThrow({ where: { id: orgId } });
    await Bun.sleep(20);
    for (let i = 0; i < 3; i++) expect(await store.ensureOrg(key)).toBe(orgId);
    const after = await database.client.org.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test("concurrent first calls from one Workspace create one org", async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-race" }),
      ),
    );
    expect(new Set(ids).size).toBe(1);
  });
});

describe("release notes", () => {
  test("putNotes stores the notes and getRelease reads them back", async () => {
    const orgId = await store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-put" });
    const stored = await put(orgId, "1.0.0", { en: "Hello", "zh-CN": "你好" });
    expect(stored).toMatchObject({
      app: "demo",
      version: "1.0.0",
      channel: "stable",
      notes: { en: "Hello", "zh-CN": "你好" },
    });
    expect(stored.updatedAt).toBeInstanceOf(Date);
    expect(await store.getRelease(orgId, "demo", "1.0.0")).toEqual(stored);
  });

  test("putNotes again replaces the whole set and drops locales not sent", async () => {
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-replace",
    });
    const first = await put(orgId, "2.0.0", { en: "one", fr: "un" }, "agent-1");
    const second = await put(orgId, "2.0.0", { en: "uno", de: "eins" }, "agent-2");
    expect(second.notes).toEqual({ en: "uno", de: "eins" });
    expect((await store.getRelease(orgId, "demo", "2.0.0"))?.notes).toEqual({
      en: "uno",
      de: "eins",
    });
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  test("getRelease is null for an unknown version, app or org", async () => {
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-null",
    });
    await put(orgId, "1.0.0", { en: "x" });
    expect(await store.getRelease(orgId, "demo", "9.9.9")).toBeNull();
    expect(await store.getRelease(orgId, "other-app", "1.0.0")).toBeNull();
    expect(
      await store.getRelease("0199a8c0-0000-7000-8000-000000000000", "demo", "1.0.0"),
    ).toBeNull();
  });

  test("an org never sees another org's releases", async () => {
    const a = await store.ensureOrg({ issuer: "https://a.example/oidc", workspaceId: "w-iso" });
    const b = await store.ensureOrg({ issuer: "https://b.example/oidc", workspaceId: "w-iso" });
    await put(a, "1.0.0", { en: "secret" });
    expect(await store.getRelease(b, "demo", "1.0.0")).toBeNull();
    expect(await store.listReleases(b, "demo")).toEqual([]);
  });

  test("a concurrent put of the same version leaves one consistent set", async () => {
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-conc",
    });
    await Promise.all([
      put(orgId, "3.0.0", { en: "a", fr: "a" }),
      put(orgId, "3.0.0", { en: "b", de: "b" }),
      put(orgId, "3.0.0", { en: "c" }),
    ]);
    const notes = (await store.getRelease(orgId, "demo", "3.0.0"))?.notes ?? {};
    const allowed: Record<string, string>[] = [
      { en: "a", fr: "a" },
      { en: "b", de: "b" },
      { en: "c" },
    ];
    expect(allowed).toContainEqual(notes);
  });
});

describe("listReleases", () => {
  test("lists an app's releases with their locales, optionally for one channel", async () => {
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-list",
    });
    await put(orgId, "1.0.0", { en: "a", "zh-CN": "b" });
    await put(orgId, "1.1.0-dev.1", { en: "c" });
    await store.putNotes({
      orgId,
      app: "elsewhere",
      version: "1.0.0",
      channel: "stable",
      agentId: "a",
      notes: { en: "z" },
    });

    const all = await store.listReleases(orgId, "demo");
    expect(all.map((r) => r.version).sort()).toEqual(["1.0.0", "1.1.0-dev.1"]);
    expect(all.find((r) => r.version === "1.0.0")).toMatchObject({
      channel: "stable",
      locales: ["en", "zh-CN"],
    });

    const dev = await store.listReleases(orgId, "demo", "dev");
    expect(dev.map((r) => r.version)).toEqual(["1.1.0-dev.1"]);
  });
});
