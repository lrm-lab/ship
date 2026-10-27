import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "#src/generated/prisma/client";
import { channelOf } from "#src/releases";
import { createDatabase, type Database } from "#src/store/database";
import { createPrismaReleaseStore } from "#src/store/prisma-release-store";
import type { ReleaseStore } from "#src/store/release-store";
import { createTestDatabase, type TestDatabase } from "./support/postgres";

let postgres: TestDatabase;
let database: Database;
let store: ReleaseStore;

beforeAll(async () => {
  postgres = await createTestDatabase();
  database = createDatabase(postgres.url);
  store = createPrismaReleaseStore(database.client);
}, 120_000);

afterAll(async () => {
  await database?.close();
  await postgres?.drop();
});

const put = (orgId: string, version: string, notes: Record<string, string>, agentId = "agent-1") =>
  store.putNotes({
    orgId,
    app: "demo",
    version,
    channel: channelOf(version),
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

  test("findOrg answers null for an unknown Workspace and creates nothing", async () => {
    const key = { issuer: "https://a.example/oidc", workspaceId: "w-find" };
    expect(await store.findOrg(key)).toBeNull();
    expect(await database.client.org.count({ where: key })).toBe(0);
    const orgId = await store.ensureOrg(key);
    expect(await store.findOrg(key)).toBe(orgId);
  });

  test("an unknown Workspace is not remembered: an org created elsewhere is found next time", async () => {
    const key = { issuer: "https://a.example/oidc", workspaceId: "w-late" };
    expect(await store.findOrg(key)).toBeNull();
    const created = await database.client.org.create({ data: key, select: { id: true } });
    expect(await store.findOrg(key)).toBe(created.id);
  });

  test("a known org is remembered, so later lookups need no query", async () => {
    const key = { issuer: "https://a.example/oidc", workspaceId: "w-cache" };
    const orgId = await store.ensureOrg(key);
    await database.client.org.delete({ where: { id: orgId } }); // orgs are never deleted in practice
    expect(await store.findOrg(key)).toBe(orgId);
    expect(await store.ensureOrg(key)).toBe(orgId);
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
  test("concurrent first puts of a brand new version all succeed, over several rounds", async () => {
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-first",
    });
    for (let round = 0; round < 8; round++) {
      const version = `5.${round}.0`;
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          put(orgId, version, { en: `writer ${i}` }, `agent-${i}`),
        ),
      );
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      const stored = await store.getRelease(orgId, "demo", version);
      expect(Object.keys(stored?.notes ?? {})).toEqual(["en"]);
      expect(await database.client.release.count({ where: { orgId, version } })).toBe(1);
    }
  });

  test("a put that loses a unique-violation race on the release is retried once", async () => {
    // Prisma's upsert is a native ON CONFLICT here, so the race cannot be provoked; make the
    // first upsert of the release fail the way a lost race does.
    const violation = () =>
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
    const flaky = (failures: number) =>
      new Proxy(database.client, {
        get(target, name) {
          if (name !== "$transaction") return Reflect.get(target, name);
          return (run: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              run(
                new Proxy(tx, {
                  get(inner, model) {
                    if (model !== "release") return Reflect.get(inner, model);
                    return new Proxy(inner.release, {
                      get(delegate, method) {
                        if (method === "upsert" && failures-- > 0)
                          return () => Promise.reject(violation());
                        return Reflect.get(delegate, method);
                      },
                    });
                  },
                }),
              ),
            );
        },
      });
    const orgId = await store.ensureOrg({
      issuer: "https://a.example/oidc",
      workspaceId: "w-retry",
    });
    const input = {
      orgId,
      app: "demo",
      version: "6.0.0",
      channel: "stable" as const,
      agentId: "a",
      notes: { en: "x" },
    };
    const once = await createPrismaReleaseStore(flaky(1)).putNotes(input);
    expect(once.notes).toEqual({ en: "x" });
    expect(await store.getRelease(orgId, "demo", "6.0.0")).toMatchObject({ notes: { en: "x" } });
    // a second failure is not swallowed
    await expect(
      createPrismaReleaseStore(flaky(2)).putNotes({ ...input, version: "6.0.1" }),
    ).rejects.toThrow();
    // another kind of error is not retried
    let calls = 0;
    const broken = new Proxy(database.client, {
      get(target, name) {
        if (name !== "$transaction") return Reflect.get(target, name);
        return () => (calls++, Promise.reject(new Error("database down")));
      },
    });
    await expect(createPrismaReleaseStore(broken).putNotes(input)).rejects.toThrow("database down");
    expect(calls).toBe(1);
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
