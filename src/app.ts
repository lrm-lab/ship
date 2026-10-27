import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import type { JWTVerifyGetKey } from "jose";
import { createTokenVerifier, missingScopes, type Caller } from "./auth";
import type { Config } from "./config";
import {
  API_PREFIX,
  MANIFEST_PATH,
  actions as defaultActions,
  buildManifest,
  type Action,
} from "./manifest";
import { publicReleaseUrl, registerPublicRoutes } from "./public-routes";
import { createReleaseHandlers } from "./releases";
import type { ReleaseStore } from "./store/release-store";
import { coerceQuery, validate } from "./validate";

const REALM = "ship";
// The largest valid notes are 20 locales of 16000 characters; a client may send each as a 6-byte
// \uXXXX escape, so about 1.9 MB. The cap leaves room for that.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The caller, and the org the pipeline resolved for it: null for a read by a Workspace with no org yet. */
export type HandlerContext = Caller & { orgId: string | null };
export type HandlerResponse = { status: ContentfulStatusCode; body: unknown };
/** What an action does: it receives validated input and the context, and returns { status, body }. */
export type Handler = (
  input: any,
  context: HandlerContext,
) => HandlerResponse | Promise<HandlerResponse>;
/** The handlers by action name; createApp refuses to boot if one is missing. */
export type Handlers = Record<string, Handler>;

export type AppDeps = {
  /** Key sets by issuer, replacing the remote `<issuer>/jwks` ones (tests). */
  keys?: Record<string, JWTVerifyGetKey>;
  /** Where releases and orgs are kept. */
  store: ReleaseStore;
  actions?: Action[];
  handlers?: Handlers;
};

export function createApp(
  config: Config,
  {
    keys,
    store,
    handlers = createReleaseHandlers(store, (orgId, { app, version }) =>
      publicReleaseUrl(config.appOrigin, orgId, app, version),
    ),
    actions = defaultActions,
  }: AppDeps,
) {
  const verify = createTokenVerifier(config.trustedIssuers, keys);
  const app = new Hono();

  for (const action of actions) {
    if (typeof handlers[action.name] !== "function")
      throw new Error(`No handler for action ${action.name}`);
  }

  const manifest = buildManifest(config, actions);
  app.get(MANIFEST_PATH, (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(manifest);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  registerPublicRoutes(app, store);

  const challenge = (error: string, extra = "") =>
    `Bearer realm="${REALM}", error="${error}"${extra}`;

  for (const action of actions) {
    const route = `${API_PREFIX}${action.endpoint.path.replace(/\{(\w+)\}/g, ":$1")}`;
    const method = action.endpoint.method.toLowerCase();
    app.on(
      action.endpoint.method,
      route,
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: "payload_too_large", message: "Body too large" }, 413),
      }),
      async (c) => {
        c.header("Cache-Control", "no-store");

        // 1. Authenticate: a valid Agent access token for this app.
        const token = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
        if (!token) {
          c.header("WWW-Authenticate", `Bearer realm="${REALM}"`);
          return c.json({ error: "unauthorized", message: "Bearer token required" }, 401);
        }
        let caller: Caller;
        try {
          caller = await verify(token);
        } catch {
          c.header("WWW-Authenticate", challenge("invalid_token"));
          return c.json(
            { error: "invalid_token", message: "The access token was not accepted" },
            401,
          );
        }

        // 2. Authorize: the token CoForge minted for this call must carry the action's scopes.
        //    Who may touch which data is decided below, in the handler, by workspaceId and agentId.
        const lacking = missingScopes(caller.scopes, action.required_scopes);
        if (lacking.length > 0) {
          c.header(
            "WWW-Authenticate",
            challenge("insufficient_scope", `, scope="${action.required_scopes.join(" ")}"`),
          );
          return c.json(
            { error: "insufficient_scope", message: `Missing scope: ${lacking.join(", ")}` },
            403,
          );
        }

        // 3. Assemble and validate input the way the manifest promises: path parameters,
        //    then the query for GET/DELETE or the JSON body for the others.
        let input: Record<string, unknown> = { ...c.req.param() };
        if (method === "get" || method === "delete") {
          input = { ...coerceQuery(action.input_schema, c.req.queries()), ...input };
        } else {
          // bodyLimit (above) caps the bytes read, chunked bodies included; reading past it throws.
          let text: string;
          try {
            text = await c.req.text();
          } catch {
            return c.json({ error: "payload_too_large", message: "Body too large" }, 413);
          }
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            return c.json({ error: "invalid_input", message: "Body is not valid JSON" }, 400);
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            return c.json({ error: "invalid_input", message: "Body must be a JSON object" }, 400);
          }
          input = { ...(body as Record<string, unknown>), ...input };
        }
        const problems = validate(action.input_schema, input);
        if (problems.length > 0)
          return c.json({ error: "invalid_input", message: "Input is invalid", problems }, 400);

        // 4. Resolve the tenant: the caller's org. A read only looks it up, so reading never
        //    creates an org; a write creates it on the Workspace's first call.
        const orgKey = { issuer: caller.issuer, workspaceId: caller.workspaceId };
        const orgId =
          action.effect === "read" ? await store.findOrg(orgKey) : await store.ensureOrg(orgKey);

        const response = await handlers[action.name]!(input, { ...caller, orgId });
        return c.json(response.body as never, response.status);
      },
    );
  }

  app.notFound((c) => c.json({ error: "not_found", message: "No such route" }, 404));
  app.onError((error, c) => {
    console.error("unhandled error:", error.message);
    return c.json({ error: "internal_error", message: "Something went wrong" }, 500);
  });
  return app;
}
