import type { Hono } from "hono";
import { APP_SCHEMA, VERSION_SCHEMA } from "./manifest";
import { releaseBody } from "./release-body";
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

/**
 * The public, token-less read of one release's notes, for CoForge Web's "What's new". It is not
 * an action of the manifest. The org id is an unguessable id, not a credential: anyone who knows
 * it can read what that org published. A malformed id, app or version answers the same 404 as a
 * release that does not exist, so the response never says which part was wrong.
 */
export function registerPublicRoutes(app: Hono, store: ReleaseStore) {
  app.get(PUBLIC_RELEASE_PATH, async (c) => {
    c.header("Cache-Control", "no-cache");
    const params = c.req.param();
    const release =
      validate(PARAMS_SCHEMA, params).length === 0
        ? await store.getRelease(
            params.orgId as string,
            params.app as string,
            params.version as string,
          )
        : null;
    if (!release) return c.json({ error: "not_found", message: "No such release" }, 404);
    return c.json(releaseBody(release));
  });
}
