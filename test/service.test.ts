import { beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { generateKeyPair } from "jose";
import { createApp } from "#src/app";
import { loadConfig } from "#src/config";
import { buildManifest, type Action } from "#src/manifest";
import type { ReleaseStore } from "#src/store/release-store";
import {
  createTestIssuer,
  signAgentToken,
  type AgentTokenOptions,
  type TestIssuer,
} from "./support/issuers";

const BASE = "https://ship.example.com";

let app: Hono;
let issuerA: TestIssuer;
let issuerB: TestIssuer;
let otherKey: CryptoKey;
let config: ReturnType<typeof loadConfig>;

/** An Agent access token of issuer A unless `issuer` says otherwise. */
const token = (overrides: AgentTokenOptions = {}, issuer = issuerA) =>
  signAgentToken(issuer, overrides);

/** Stand-ins for the release actions, so this file tests the generic machinery on its own. */
const whoami: Action = {
  name: "test.whoami",
  effect: "read",
  idempotency: "safe",
  endpoint: { method: "GET", path: "/whoami" },
  required_scopes: [],
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};
const echo: Action = {
  name: "test.echo",
  effect: "create",
  idempotency: "non_idempotent",
  endpoint: { method: "POST", path: "/echo" },
  required_scopes: [],
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", maxLength: 5000 },
    },
    required: ["title"],
    additionalProperties: false,
  },
};
const testHandlers = {
  "test.whoami": (
    _input: unknown,
    caller: { issuer: string; workspaceId: string; agentId: string },
  ) => ({
    status: 200 as const,
    body: { issuer: caller.issuer, workspaceId: caller.workspaceId, agentId: caller.agentId },
  }),
  "test.echo": ({ title, body = "" }: { title: string; body?: string }) => ({
    status: 201 as const,
    body: { id: crypto.randomUUID(), title, body },
  }),
};

const keysByIssuer = () => ({ [issuerA.issuer]: issuerA.keySet, [issuerB.issuer]: issuerB.keySet });

type CallOptions = {
  method?: string;
  bearer?: string;
  body?: unknown;
  headers?: Record<string, string>;
};
const call = async (
  path: string,
  { method = "GET", bearer, body, headers = {} }: CallOptions = {},
) =>
  app.request(`${BASE}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("hosted HTTP action service", () => {
  beforeAll(async () => {
    issuerA = await createTestIssuer("https://a.coforge.example/oidc", "ship-a");
    issuerB = await createTestIssuer("https://b.coforge.example/oidc", "ship-b");
    otherKey = (await generateKeyPair("ES256")).privateKey;
    config = loadConfig({
      SHIP_TRUSTED_ISSUERS: JSON.stringify([
        { issuer: issuerA.issuer, clientId: issuerA.clientId },
        { issuer: issuerB.issuer, clientId: issuerB.clientId },
      ]),
      APP_ORIGIN: BASE,
      DATABASE_URL: "postgresql://unused@localhost:5432/unused",
    });
    app = createApp(config, {
      keys: keysByIssuer(),
      actions: [whoami, echo],
      handlers: testHandlers,
    });
  });

  test("publishes the manifest without authentication", async () => {
    const withReleases = createApp(config, { keys: keysByIssuer(), store: {} as ReleaseStore });
    const res = await withReleases.request(`${BASE}/.well-known/coforge-agent-manifest.json`);
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest).toEqual(JSON.parse(JSON.stringify(buildManifest(config))));
    expect(manifest.execution.base_url).toBe(`${BASE}/api`);
    expect(manifest.name).toBe("Ship");
  });

  describe("access token verification", () => {
    test("no token: 401 with a bare challenge", async () => {
      const res = await call("/api/whoami");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
    });

    for (const [name, make] of [
      ["from an issuer Ship does not trust", () => token({ iss: "https://evil.example/oidc" })],
      ["wrong audience", () => token({ aud: "another-app" })],
      ["expired", () => token({ expiresIn: Math.floor(Date.now() / 1000) - 60 })],
      ["signed by another key", () => token({ key: otherKey })],
      ["not typ at+jwt", () => token({ typ: "JWT" })],
      ["not an Agent token", () => token({ claims: { type: "user" } })],
      ["no workspace", () => token({ claims: { workspace_id: undefined } })],
      ["issued by B but carrying A's client ID", () => token({ aud: issuerA.clientId }, issuerB)],
      ["claiming issuer A but signed by B's key", () => token({ key: issuerB.privateKey })],
      [
        "claiming issuer B with B's client ID but signed by A's key",
        () => token({ key: issuerA.privateKey }, issuerB),
      ],
    ] as [string, () => Promise<string>][]) {
      test(`rejects a token that is ${name}`, async () => {
        const res = await call("/api/whoami", { bearer: await make() });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
      });
    }

    test("accepts a valid token from each trusted issuer", async () => {
      for (const issuer of [issuerA, issuerB]) {
        const res = await call("/api/whoami", { bearer: await token({}, issuer) });
        expect(res.status).toBe(200);
        expect((await res.json()).issuer).toBe(issuer.issuer);
      }
    });

    test("rejects tokens that are not decodable JWTs", async () => {
      for (const bearer of ["abc", "a.b.c", "x".repeat(50)]) {
        const res = await call("/api/whoami", { bearer });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
      }
    });

    test("rejects an unsigned (alg none) token naming a trusted issuer", async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const claims = {
        iss: issuerA.issuer,
        aud: issuerA.clientId,
        sub: "a",
        type: "agent",
        workspace_id: "w1",
        scope: "openid",
        exp: 9999999999,
      };
      const forged = `${b64({ alg: "none", typ: "at+jwt" })}.${b64(claims)}.`;
      expect((await call("/api/whoami", { bearer: forged })).status).toBe(401);
    });
  });

  test("a token lacking the action's required scope gets 403 insufficient_scope", async () => {
    const emailAction: Action = {
      name: "profile.email",
      effect: "read",
      idempotency: "safe",
      endpoint: { method: "GET", path: "/email" },
      required_scopes: ["email"],
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    };
    const strict = createApp(config, {
      keys: keysByIssuer(),
      actions: [emailAction],
      handlers: { "profile.email": () => ({ status: 200, body: {} }) },
    });
    const ask = async (scope: string) =>
      strict.request(`${BASE}/api/email`, {
        headers: { authorization: `Bearer ${await token({ claims: { scope } })}` },
      });
    const denied = await ask("openid profile identity");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toMatch(/insufficient_scope/);
    expect((await ask("openid profile identity email")).status).toBe(200);
  });

  test("validates input", async () => {
    const bearer = await token();
    for (const body of [{}, { title: "" }, { title: "ok", extra: 1 }, { title: 5 }]) {
      const res = await call("/api/echo", { method: "POST", bearer, body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
    const notJson = await app.request(`${BASE}/api/echo`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: "{nope",
    });
    expect(notJson.status).toBe(400);
  });

  test("a valid body reaches the handler", async () => {
    const res = await call("/api/echo", {
      method: "POST",
      bearer: await token(),
      body: { title: "Hello", body: "world" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "Hello", body: "world" });
  });

  test("the caller is the issuer, Workspace and Agent of the token", async () => {
    const res = await call("/api/whoami", {
      bearer: await token({ sub: "agent-7", claims: { workspace_id: "w9" } }, issuerB),
    });
    expect(await res.json()).toEqual({
      issuer: issuerB.issuer,
      workspaceId: "w9",
      agentId: "agent-7",
    });
  });

  test("rejects an unknown query parameter on a GET", async () => {
    const res = await call("/api/whoami?extra=1", { bearer: await token() });
    expect(res.status).toBe(400);
  });

  describe("request handling details", () => {
    const base = {
      effect: "create" as const,
      endpoint: { method: "POST" as const, path: "/slow" },
      idempotency: "non_idempotent" as const,
      required_scopes: [],
      input_schema: {
        type: "object",
        properties: { n: { type: "integer" } },
        required: ["n"],
        additionalProperties: false,
      },
    };
    const post = (a: Hono, body: unknown) =>
      a.request(`${BASE}/api/slow`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerPromise}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let bearerPromise = "";
    beforeAll(async () => {
      bearerPromise = await token();
    });

    test("a body over the limit is refused, chunked or not", async () => {
      const a = createApp(config, {
        keys: keysByIssuer(),
        actions: [{ ...base, name: "slow.run" }],
        handlers: { "slow.run": () => ({ status: 201, body: {} }) },
      });
      const big = JSON.stringify({ n: 1, pad: "x".repeat(1100 * 1024) });
      expect((await post(a, JSON.parse(big))).status).toBe(413);
      const chunked = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      });
      const res = await a.request(`${BASE}/api/slow`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerPromise}`,
          "content-type": "application/json",
        },
        body: chunked,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(413);
    });

    test("GET query strings are coerced to the declared types", async () => {
      let seen: unknown;
      const a = createApp(config, {
        keys: keysByIssuer(),
        actions: [
          {
            name: "q.get",
            effect: "read",
            endpoint: { method: "GET" as const, path: "/q" },
            idempotency: "safe" as const,
            required_scopes: [],
            input_schema: {
              type: "object",
              properties: {
                limit: { type: "integer", minimum: 1 },
                ratio: { type: "number" },
                all: { type: "boolean" },
                tags: { type: "array", items: { type: "string" } },
                q: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        ],
        handlers: { "q.get": (input: unknown) => ((seen = input), { status: 200, body: {} }) },
      });
      const get = (qs: string) =>
        a.request(`${BASE}/api/q?${qs}`, { headers: { authorization: `Bearer ${bearerPromise}` } });
      expect((await get("limit=5&ratio=1.5&all=true&tags=a&tags=b&q=007")).status).toBe(200);
      expect(seen).toEqual({ limit: 5, ratio: 1.5, all: true, tags: ["a", "b"], q: "007" });
      for (const bad of [
        "limit=abc",
        "limit=0x10",
        "limit=1.5",
        "all=yes",
        "ratio=1e3",
        "limit=1&limit=2",
      ]) {
        expect((await get(bad)).status).toBe(400);
      }
    });
  });
});
