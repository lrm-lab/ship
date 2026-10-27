import { beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { createApp } from "#src/app";
import { loadConfig } from "#src/config";
import { type Action } from "#src/manifest";

const ISSUER = "https://coforge.example.com/oidc";
const CLIENT_ID = "notes-service";
const BASE = "https://notes.example.com";
const config = loadConfig({
  COFORGE_ISSUER: ISSUER,
  COFORGE_CLIENT_ID: CLIENT_ID,
  APP_ORIGIN: BASE,
});

let app: Hono;
let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

/** An Agent access token shaped like docs: RFC 9068, ES256, typ at+jwt, 5 minutes. */
type TokenOverrides = {
  iss?: string;
  aud?: string;
  sub?: string;
  claims?: Record<string, unknown>;
};
async function token(
  overrides: TokenOverrides = {},
  { key = privateKey, typ = "at+jwt", expiresIn = "5m" as string | number } = {},
) {
  const claims = {
    client_id: CLIENT_ID,
    type: "agent",
    workspace_id: "w1",
    workspace_slug: "acme",
    scope: "openid profile identity",
    ...overrides.claims,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setSubject(overrides.sub ?? "agent-1")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti(crypto.randomUUID())
    .sign(key);
}

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
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("ES256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
    keys = createLocalJWKSet({ keys: [jwk] });
    app = createApp(config, { keys });
  });

  test("publishes the manifest without authentication", async () => {
    const res = await call("/.well-known/coforge-agent-manifest.json");
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest.schema).toBe("coforge-agent-manifest.v1");
    expect(manifest.execution.base_url).toBe(`${BASE}/api`);
  });

  describe("access token verification", () => {
    test("no token: 401 with a bare challenge", async () => {
      const res = await call("/api/notes/x");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
    });

    for (const [name, make] of [
      ["wrong issuer", () => token({ iss: "https://evil.example/oidc" })],
      ["wrong audience", () => token({ aud: "another-app" })],
      ["expired", () => token({}, { expiresIn: Math.floor(Date.now() / 1000) - 60 })],
      ["signed by another key", () => token({}, { key: otherKey })],
      ["not typ at+jwt", () => token({}, { typ: "JWT" })],
      ["not an Agent token", () => token({ claims: { type: "user" } })],
      ["no workspace", () => token({ claims: { workspace_id: undefined } })],
    ] as [string, () => Promise<string>][]) {
      test(`rejects a token that is ${name}`, async () => {
        const res = await call("/api/notes/x", { bearer: await make() });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
      });
    }

    test("rejects an unsigned (alg none) token", async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const forged = `${b64({ alg: "none", typ: "at+jwt" })}.${b64({ iss: ISSUER, aud: CLIENT_ID, sub: "a", type: "agent", workspace_id: "w1", scope: "openid", exp: 9999999999 })}.`;
      expect((await call("/api/notes/x", { bearer: forged })).status).toBe(401);
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
      keys,
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
    const headers = { "idempotency-key": "k-invalid" };
    for (const body of [{}, { title: "" }, { title: "ok", extra: 1 }, { title: 5 }]) {
      const res = await call("/api/notes", { method: "POST", bearer, body, headers });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
    const notJson = await app.request(`${BASE}/api/notes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "idempotency-key": "k",
        "content-type": "application/json",
      },
      body: "{nope",
    });
    expect(notJson.status).toBe(400);
  });

  test("requires the idempotency header on a key_required action", async () => {
    const res = await call("/api/notes", {
      method: "POST",
      bearer: await token(),
      body: { title: "t" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("idempotency_key_required");
  });

  test("create, replay with the same key, conflict on different input, then read", async () => {
    const bearer = await token();
    const headers = { "idempotency-key": "key-1" };
    const first = await call("/api/notes", {
      method: "POST",
      bearer,
      body: { title: "Hello", body: "world" },
      headers,
    });
    expect(first.status).toBe(201);
    const note = await first.json();

    const replay = await call("/api/notes", {
      method: "POST",
      bearer,
      body: { body: "world", title: "Hello" },
      headers,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(note);

    const clash = await call("/api/notes", {
      method: "POST",
      bearer,
      body: { title: "Different" },
      headers,
    });
    expect(clash.status).toBe(422);

    const read = await call(`/api/notes/${note.id}`, { bearer });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(note);
  });

  test("notes are private to a Workspace", async () => {
    const created = await call("/api/notes", {
      method: "POST",
      bearer: await token(),
      body: { title: "mine" },
      headers: { "idempotency-key": "ws-1" },
    });
    const { id } = await created.json();
    const other = await call(`/api/notes/${id}`, {
      bearer: await token({ claims: { workspace_id: "w2" } }),
    });
    expect(other.status).toBe(404);
  });

  test("rejects an unknown query parameter on a GET", async () => {
    const res = await call("/api/notes/abc?extra=1", { bearer: await token() });
    expect(res.status).toBe(400);
  });

  describe("request handling details", () => {
    const base = {
      effect: "create" as const,
      endpoint: { method: "POST" as const, path: "/slow" },
      idempotency: "key_required" as const,
      idempotency_header: "Idempotency-Key",
      required_scopes: [],
      input_schema: {
        type: "object",
        properties: { n: { type: "integer" } },
        required: ["n"],
        additionalProperties: false,
      },
    };
    const post = (a: Hono, body: unknown, key: string) =>
      a.request(`${BASE}/api/slow`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerPromise}`,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
    let bearerPromise = "";
    beforeAll(async () => {
      bearerPromise = await token();
    });

    test("a duplicate that arrives while the first call runs gets 409, then the replay", async () => {
      let runs = 0;
      let release: (value?: unknown) => void = () => {};
      const gate = new Promise((resolve) => (release = resolve));
      const a = createApp(config, {
        keys,
        actions: [{ ...base, name: "slow.run" }],
        handlers: {
          "slow.run": async () => ((runs += 1), await gate, { status: 201, body: { ran: runs } }),
        },
      });
      const first = post(a, { n: 1 }, "same");
      await new Promise((r) => setTimeout(r, 20));
      const second = await post(a, { n: 1 }, "same");
      expect(second.status).toBe(409);
      expect(second.headers.get("retry-after")).toBe("1");
      release();
      expect((await first).status).toBe(201);
      const third = await post(a, { n: 1 }, "same");
      expect(third.headers.get("idempotency-replayed")).toBe("true");
      expect(runs).toBe(1);
    });

    test("a failed call releases its key so a retry can run", async () => {
      let runs = 0;
      const a = createApp(config, {
        keys,
        actions: [{ ...base, name: "slow.run" }],
        handlers: {
          "slow.run": async () =>
            ++runs === 1 ? { status: 503, body: { error: "later" } } : { status: 201, body: {} },
        },
      });
      expect((await post(a, { n: 1 }, "retry")).status).toBe(503);
      expect((await post(a, { n: 1 }, "retry")).status).toBe(201);
    });

    test("a body over the limit is refused, chunked or not", async () => {
      const a = createApp(config, {
        keys,
        actions: [{ ...base, name: "slow.run" }],
        handlers: { "slow.run": () => ({ status: 201, body: {} }) },
      });
      const big = JSON.stringify({ n: 1, pad: "x".repeat(70 * 1024) });
      expect((await post(a, JSON.parse(big), "big")).status).toBe(413);
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
          "idempotency-key": "chunk",
        },
        body: chunked,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(413);
    });

    test("GET query strings are coerced to the declared types", async () => {
      let seen: unknown;
      const a = createApp(config, {
        keys,
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
