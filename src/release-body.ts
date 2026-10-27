import type { StoredRelease } from "./store/release-store";

/** The wire form of a stored release, as the public endpoint returns it. */
export const releaseBody = ({ app, version, channel, notes, updatedAt }: StoredRelease) => ({
  app,
  version,
  channel,
  notes,
  updatedAt: updatedAt.toISOString(),
});

/** Where a release's notes are public (src/public-routes.ts serves it). */
export const publicReleaseUrl = (appOrigin: string, orgId: string, app: string, version: string) =>
  `${appOrigin}/public/v1/orgs/${orgId}/apps/${app}/releases/${encodeURIComponent(version)}`;
