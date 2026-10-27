import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createTokenVerifier, missingScopes } from "./auth.js";
import { createIdempotencyStore } from "./idempotency.js";
import { API_PREFIX, MANIFEST_PATH, actions as defaultActions, buildManifest } from "./manifest.js";
import { coerceQuery, validate } from "./validate.js";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * What each manifest action does. Keyed by action name; app.js refuses to boot if the two
 * lists drift apart. A handler receives validated input and the caller; it returns
 * { status, body }.
 */
function createHandlers() {
  /** Notes live in memory, partitioned by Workspace: replace with your database. */
  const notes = new Map();
  const forWorkspace = (id) => notes.get(id) ?? notes.set(id, new Map()).get(id);
  return {
    "notes.get": ({ id }, caller) => {
      const note = forWorkspace(caller.workspaceId).get(id);
      return note ? { status: 200, body: note } : { status: 404, body: { error: "not_found", message: "No such note" } };
    },
    "notes.create": ({ title, body = "" }, caller) => {
      const note = { id: randomUUID(), title, body };
      forWorkspace(caller.workspaceId).set(note.id, note);
      return { status: 201, body: note };
    },
  };
}

/**
 * @param {import("./config.js").Config} config
 * @param {{ keys?: import("jose").JWTVerifyGetKey, actions?: typeof defaultActions, handlers?: ReturnType<typeof createHandlers>, idempotency?: ReturnType<typeof createIdempotencyStore> }} [deps]
 */
export function createApp(config, { keys, handlers = createHandlers(), idempotency = createIdempotencyStore(), actions = defaultActions } = {}) {
  const verify = createTokenVerifier(config, keys);
  const app = new Hono();

  for (const action of actions) {
    if (typeof handlers[action.name] !== "function") throw new Error(`No handler for action ${action.name}`);
  }

  app.get(MANIFEST_PATH, (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ ...buildManifest(config), actions });
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  const challenge = (error, extra = "") => `Bearer realm="${config.issuer}", error="${error}"${extra}`;

  for (const action of actions) {
    const route = `${API_PREFIX}${action.endpoint.path.replace(/\{(\w+)\}/g, ":$1")}`;
    const method = action.endpoint.method.toLowerCase();
    app.on(action.endpoint.method, route, bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "payload_too_large", message: "Body too large" }, 413),
    }), async (c) => {
      c.header("Cache-Control", "no-store");

      // 1. Authenticate: a valid Agent access token for this app.
      const token = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token) {
        c.header("WWW-Authenticate", `Bearer realm="${config.issuer}"`);
        return c.json({ error: "unauthorized", message: "Bearer token required" }, 401);
      }
      let caller;
      try {
        caller = await verify(token);
      } catch {
        c.header("WWW-Authenticate", challenge("invalid_token"));
        return c.json({ error: "invalid_token", message: "The access token was not accepted" }, 401);
      }

      // 2. Authorize: the token CoForge minted for this call must carry the action's scopes.
      //    Who may touch which data is decided below, in the handler, by workspaceId and agentId.
      const lacking = missingScopes(caller.scopes, action.required_scopes);
      if (lacking.length > 0) {
        c.header("WWW-Authenticate", challenge("insufficient_scope", `, scope="${action.required_scopes.join(" ")}"`));
        return c.json({ error: "insufficient_scope", message: `Missing scope: ${lacking.join(", ")}` }, 403);
      }

      // 3. Assemble and validate input the way the manifest promises: path parameters,
      //    then the query for GET/DELETE or the JSON body for the others.
      let input = { ...c.req.param() };
      if (method === "get" || method === "delete") {
        input = { ...coerceQuery(action.input_schema, c.req.queries()), ...input };
      } else {
        // bodyLimit (above) caps the bytes read, chunked bodies included; reading past it throws.
        let text;
        try {
          text = await c.req.text();
        } catch {
          return c.json({ error: "payload_too_large", message: "Body too large" }, 413);
        }
        let body;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          return c.json({ error: "invalid_input", message: "Body is not valid JSON" }, 400);
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return c.json({ error: "invalid_input", message: "Body must be a JSON object" }, 400);
        }
        input = { ...body, ...input };
      }
      const problems = validate(action.input_schema, input);
      if (problems.length > 0) return c.json({ error: "invalid_input", message: "Input is invalid", problems }, 400);

      // 4. Idempotency: a key_required action runs once per key. The key is reserved before the
      //    handler runs; a duplicate that arrives meanwhile gets 409 with Retry-After.
      let scope;
      let key;
      if (action.idempotency === "key_required") {
        key = c.req.header(action.idempotency_header)?.trim();
        if (!key || key.length > 255) {
          return c.json({ error: "idempotency_key_required", message: `Send ${action.idempotency_header}` }, 400);
        }
        scope = `${caller.workspaceId}\n${caller.agentId}\n${action.name}`;
        const seen = idempotency.begin(scope, key, input);
        if (seen.state === "conflict") {
          return c.json({ error: "idempotency_key_reused", message: "That key was used with different input" }, 422);
        }
        if (seen.state === "in_flight") {
          c.header("Retry-After", "1");
          return c.json({ error: "request_in_progress", message: "The first call with this key is still running; retry shortly" }, 409);
        }
        if (seen.state === "replay") {
          c.header("Idempotency-Replayed", "true");
          return c.json(seen.response.body, seen.response.status);
        }
      }

      let response;
      try {
        response = await handlers[action.name](input, caller);
      } catch (error) {
        if (key) idempotency.release(scope, key);
        throw error;
      }
      if (key) {
        if (response.status < 300) idempotency.complete(scope, key, response);
        else idempotency.release(scope, key); // a failed call may be retried
      }
      return c.json(response.body, response.status);
    });
  }

  app.notFound((c) => c.json({ error: "not_found", message: "No such route" }, 404));
  app.onError((error, c) => {
    console.error("unhandled error:", error.message);
    return c.json({ error: "internal_error", message: "Something went wrong" }, 500);
  });
  return app;
}
