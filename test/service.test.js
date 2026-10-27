import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { actions } from "../src/manifest.js";

const ISSUER = "https://coforge.example.com/oidc";
const CLIENT_ID = "notes-service";
const BASE = "https://notes.example.com";
const config = loadConfig({ COFORGE_ISSUER: ISSUER, COFORGE_CLIENT_ID: CLIENT_ID, APP_ORIGIN: BASE });

let app;
let keys;
let privateKey;
let otherKey;

/** An Agent access token shaped like docs: RFC 9068, ES256, typ at+jwt, 5 minutes. */
async function token(overrides = {}, { key = privateKey, typ = "at+jwt", expiresIn = "5m" } = {}) {
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

const call = async (path, { method = "GET", bearer, body, headers = {} } = {}) =>
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
  before(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("ES256")).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
    keys = createLocalJWKSet({ keys: [jwk] });
    app = createApp(config, { keys });
  });

  test("publishes the manifest without authentication", async () => {
    const res = await call("/.well-known/coforge-agent-manifest.json");
    assert.equal(res.status, 200);
    const manifest = await res.json();
    assert.equal(manifest.schema, "coforge-agent-manifest.v1");
    assert.equal(manifest.execution.base_url, `${BASE}/api`);
  });

  describe("access token verification", () => {
    test("no token: 401 with a bare challenge", async () => {
      const res = await call("/api/notes/x");
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate"), /^Bearer realm=/);
    });

    for (const [name, make] of [
      ["wrong issuer", () => token({ iss: "https://evil.example/oidc" })],
      ["wrong audience", () => token({ aud: "another-app" })],
      ["expired", () => token({}, { expiresIn: Math.floor(Date.now() / 1000) - 60 })],
      ["signed by another key", () => token({}, { key: otherKey })],
      ["not typ at+jwt", () => token({}, { typ: "JWT" })],
      ["not an Agent token", () => token({ claims: { type: "user" } })],
      ["no workspace", () => token({ claims: { workspace_id: undefined } })],
    ]) {
      test(`rejects a token that is ${name}`, async () => {
        const res = await call("/api/notes/x", { bearer: await make() });
        assert.equal(res.status, 401);
        assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
      });
    }

    test("rejects an unsigned (alg none) token", async () => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const forged = `${b64({ alg: "none", typ: "at+jwt" })}.${b64({ iss: ISSUER, aud: CLIENT_ID, sub: "a", type: "agent", workspace_id: "w1", scope: "openid", exp: 9999999999 })}.`;
      assert.equal((await call("/api/notes/x", { bearer: forged })).status, 401);
    });
  });

  test("a token lacking the action's required scope gets 403 insufficient_scope", async () => {
    const emailAction = {
      ...actions[0],
      name: "profile.email",
      endpoint: { method: "GET", path: "/email" },
      required_scopes: ["email"],
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    };
    const strict = createApp(config, { keys, actions: [emailAction], handlers: { "profile.email": () => ({ status: 200, body: {} }) } });
    const ask = async (scope) =>
      strict.request(`${BASE}/api/email`, { headers: { authorization: `Bearer ${await token({ claims: { scope } })}` } });
    const denied = await ask("openid profile identity");
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get("www-authenticate"), /insufficient_scope/);
    assert.equal((await ask("openid profile identity email")).status, 200);
  });

  test("validates input", async () => {
    const bearer = await token();
    const headers = { "idempotency-key": "k-invalid" };
    for (const body of [{}, { title: "" }, { title: "ok", extra: 1 }, { title: 5 }]) {
      const res = await call("/api/notes", { method: "POST", bearer, body, headers });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error, "invalid_input");
    }
    const notJson = await app.request(`${BASE}/api/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "idempotency-key": "k", "content-type": "application/json" },
      body: "{nope",
    });
    assert.equal(notJson.status, 400);
  });

  test("requires the idempotency header on a key_required action", async () => {
    const res = await call("/api/notes", { method: "POST", bearer: await token(), body: { title: "t" } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "idempotency_key_required");
  });

  test("create, replay with the same key, conflict on different input, then read", async () => {
    const bearer = await token();
    const headers = { "idempotency-key": "key-1" };
    const first = await call("/api/notes", { method: "POST", bearer, body: { title: "Hello", body: "world" }, headers });
    assert.equal(first.status, 201);
    const note = await first.json();

    const replay = await call("/api/notes", { method: "POST", bearer, body: { body: "world", title: "Hello" }, headers });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await replay.json(), note);

    const clash = await call("/api/notes", { method: "POST", bearer, body: { title: "Different" }, headers });
    assert.equal(clash.status, 422);

    const read = await call(`/api/notes/${note.id}`, { bearer });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), note);
  });

  test("notes are private to a Workspace", async () => {
    const created = await call("/api/notes", {
      method: "POST",
      bearer: await token(),
      body: { title: "mine" },
      headers: { "idempotency-key": "ws-1" },
    });
    const { id } = await created.json();
    const other = await call(`/api/notes/${id}`, { bearer: await token({ claims: { workspace_id: "w2" } }) });
    assert.equal(other.status, 404);
  });

  test("rejects an unknown query parameter on a GET", async () => {
    const res = await call("/api/notes/abc?extra=1", { bearer: await token() });
    assert.equal(res.status, 400);
  });

  describe("request handling details", () => {
    const base = {
      effect: "create",
      endpoint: { method: "POST", path: "/slow" },
      idempotency: "key_required",
      idempotency_header: "Idempotency-Key",
      required_scopes: [],
      input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
    };
    const post = (a, body, key) =>
      a.request(`${BASE}/api/slow`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerPromise}`, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
    let bearerPromise;
    before(async () => {
      bearerPromise = await token();
    });

    test("a duplicate that arrives while the first call runs gets 409, then the replay", async () => {
      let runs = 0;
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const a = createApp(config, {
        keys,
        actions: [{ ...base, name: "slow.run" }],
        handlers: { "slow.run": async () => ((runs += 1), await gate, { status: 201, body: { ran: runs } }) },
      });
      const first = post(a, { n: 1 }, "same");
      await new Promise((r) => setTimeout(r, 20));
      const second = await post(a, { n: 1 }, "same");
      assert.equal(second.status, 409);
      assert.equal(second.headers.get("retry-after"), "1");
      release();
      assert.equal((await first).status, 201);
      const third = await post(a, { n: 1 }, "same");
      assert.equal(third.headers.get("idempotency-replayed"), "true");
      assert.equal(runs, 1);
    });

    test("a failed call releases its key so a retry can run", async () => {
      let runs = 0;
      const a = createApp(config, {
        keys,
        actions: [{ ...base, name: "slow.run" }],
        handlers: { "slow.run": async () => (++runs === 1 ? { status: 503, body: { error: "later" } } : { status: 201, body: {} }) },
      });
      assert.equal((await post(a, { n: 1 }, "retry")).status, 503);
      assert.equal((await post(a, { n: 1 }, "retry")).status, 201);
    });

    test("a body over the limit is refused, chunked or not", async () => {
      const a = createApp(config, { keys, actions: [{ ...base, name: "slow.run" }], handlers: { "slow.run": () => ({ status: 201, body: {} }) } });
      const big = JSON.stringify({ n: 1, pad: "x".repeat(70 * 1024) });
      assert.equal((await post(a, JSON.parse(big), "big")).status, 413);
      const chunked = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      });
      const res = await a.request(`${BASE}/api/slow`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerPromise}`, "content-type": "application/json", "idempotency-key": "chunk" },
        body: chunked,
        duplex: "half",
      });
      assert.equal(res.status, 413);
    });

    test("GET query strings are coerced to the declared types", async () => {
      let seen;
      const a = createApp(config, {
        keys,
        actions: [{
          name: "q.get", effect: "read", endpoint: { method: "GET", path: "/q" }, idempotency: "safe", required_scopes: [],
          input_schema: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1 }, ratio: { type: "number" }, all: { type: "boolean" }, tags: { type: "array", items: { type: "string" } }, q: { type: "string" } },
            additionalProperties: false,
          },
        }],
        handlers: { "q.get": (input) => ((seen = input), { status: 200, body: {} }) },
      });
      const get = (qs) => a.request(`${BASE}/api/q?${qs}`, { headers: { authorization: `Bearer ${bearerPromise}` } });
      assert.equal((await get("limit=5&ratio=1.5&all=true&tags=a&tags=b&q=007")).status, 200);
      assert.deepEqual(seen, { limit: 5, ratio: 1.5, all: true, tags: ["a", "b"], q: "007" });
      for (const bad of ["limit=abc", "limit=0x10", "limit=1.5", "all=yes", "ratio=1e3", "limit=1&limit=2"]) {
        assert.equal((await get(bad)).status, 400, bad);
      }
    });
  });
});
