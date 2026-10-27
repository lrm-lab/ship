import type { Hono } from "hono";
import { isAppName, isOrgId, isVersion } from "./release-input";
import { releaseBody } from "./releases";
import type { ReleaseStore } from "./store/release-store";

export const PUBLIC_RELEASE_PATH = "/public/v1/orgs/:orgId/apps/:app/releases/:version";

/**
 * The public, token-less read of one release's notes, for CoForge Web's "What's new". It is not
 * an action of the manifest. The org id is an unguessable id, not a credential: anyone who knows
 * it can read what that org published. A malformed id, app or version answers the same 404 as a
 * release that does not exist, so the response never says which part was wrong.
 */
export function registerPublicRoutes(app: Hono, store: ReleaseStore) {
  app.get(PUBLIC_RELEASE_PATH, async (c) => {
    c.header("Cache-Control", "no-cache");
    const { orgId, app: appName, version } = c.req.param();
    const release =
      orgId && appName && version && isOrgId(orgId) && isAppName(appName) && isVersion(version)
        ? await store.getRelease(orgId, appName, version)
        : null;
    if (!release) return c.json({ error: "not_found", message: "No such release" }, 404);
    return c.json(releaseBody(release));
  });
}
