import type { Context, Hono } from "hono";
import { APP_SCHEMA, VERSION_SCHEMA } from "./manifest";
import { releaseBody } from "./releases";
import type { ReleaseStore } from "./store/release-store";
import { validate, type Schema } from "./validate";

export const PUBLIC_RELEASE_PATH = "/public/v1/orgs/:orgId/apps/:app/releases/:version";

const PARAMS_SCHEMA: Schema = {
  type: "object",
  properties: {
    orgId: {
      type: "string",
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
    app: APP_SCHEMA,
    version: VERSION_SCHEMA,
  },
  required: ["orgId", "app", "version"],
};

/** Where a release's notes are public: the route above with its parameters filled in. */
export const publicReleaseUrl = (
  appOrigin: string,
  orgId: string,
  app: string,
  version: string,
) => {
  const params: Record<string, string> = { orgId, app, version };
  return `${appOrigin}${PUBLIC_RELEASE_PATH.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] as string))}`;
};

/**
 * The public, token-less read of one release's notes, for CoForge Web's "What's new". It is not
 * an action of the manifest. The org id is an unguessable id, not a credential: anyone who knows
 * it can read what that org published. A malformed id, app or version, or any other path under
 * /public, answers the same 404 as a release that does not exist, so the response never says what was wrong.
 */
export function registerPublicRoutes(app: Hono, store: ReleaseStore) {
  const notFound = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.json({ error: "not_found", message: "No such release" }, 404);
  };
  app.get(PUBLIC_RELEASE_PATH, async (c) => {
    const params = c.req.param();
    const release =
      validate(PARAMS_SCHEMA, params).length === 0
        ? await store.getRelease(
            params.orgId as string,
            params.app as string,
            params.version as string,
          )
        : null;
    if (!release) return notFound(c);
    c.header("Cache-Control", "no-cache");
    return c.json(releaseBody(release));
  });
  // Any other path or method under /public answers the same 404, so nothing there tells a
  // malformed request from a missing release.
  app.all("/public/*", notFound);
}
