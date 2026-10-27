import type { Caller } from "./auth";
import type { HandlerResponse, Handlers } from "./handler";
import { LIST_DEFAULT_LIMIT } from "./manifest";
import { publicReleaseUrl, releaseBody } from "./release-body";
import { compareSemVer, parseSemVer } from "./semver";
import type { ReleaseChannel, ReleaseStore, StoredRelease } from "./store/release-store";

const notFound = (): HandlerResponse => ({
  status: 404,
  body: { error: "not_found", message: "No such release" },
});

/** A version with a prerelease part (0.1.3-dev.4) is a dev build; any other is stable. */
export function channelOf(version: string): ReleaseChannel {
  return (parseSemVer(version)?.prerelease.length ?? 0) > 0 ? "dev" : "stable";
}

/** Handlers of the release actions in the manifest. Every query is scoped to the caller's org. */
export function createReleaseHandlers(store: ReleaseStore, appOrigin: string): Handlers {
  /** What notes.put and notes.get return: the release plus where it is public. */
  const withLocation = (orgId: string, release: StoredRelease) => ({
    ...releaseBody(release),
    orgId,
    publicUrl: publicReleaseUrl(appOrigin, orgId, release.app, release.version),
  });

  // The org of a Workspace is created by its first authenticated call.
  const orgOf = (caller: Caller) =>
    store.ensureOrg({ issuer: caller.issuer, workspaceId: caller.workspaceId });

  return {
    "releases.notes.put": async (
      input: { app: string; version: string; notes: Record<string, string> },
      caller,
    ) => {
      // The schema has checked the version and the notes; only trimming is left.
      const notes = Object.fromEntries(
        Object.entries(input.notes).map(([locale, text]) => [locale, text.trim()]),
      );
      const orgId = await orgOf(caller);
      const release = await store.putNotes({
        orgId,
        app: input.app,
        version: input.version,
        channel: channelOf(input.version),
        agentId: caller.agentId,
        notes,
      });
      return { status: 200, body: withLocation(orgId, release) };
    },

    "releases.notes.get": async (input: { app: string; version: string }, caller) => {
      const orgId = await orgOf(caller);
      const release = await store.getRelease(orgId, input.app, input.version);
      return release ? { status: 200, body: withLocation(orgId, release) } : notFound();
    },

    "releases.list": async (
      input: { app: string; channel?: ReleaseChannel; limit?: number },
      caller,
    ) => {
      const releases = await store.listReleases(await orgOf(caller), input.app, input.channel);
      // Newest first by SemVer precedence. Versions that differ only in build metadata have equal
      // precedence; they follow each other in descending text order so the answer is stable.
      const ranked = releases
        .map((release) => ({ release, semver: parseSemVer(release.version) }))
        .filter(
          (entry): entry is typeof entry & { semver: NonNullable<typeof entry.semver> } =>
            entry.semver !== null,
        )
        .sort(
          (a, b) =>
            compareSemVer(b.semver, a.semver) || (a.release.version < b.release.version ? 1 : -1),
        );
      return {
        status: 200,
        body: {
          releases: ranked.slice(0, input.limit ?? LIST_DEFAULT_LIMIT).map(({ release }) => ({
            version: release.version,
            channel: release.channel,
            locales: release.locales,
            updatedAt: release.updatedAt.toISOString(),
          })),
        },
      };
    },
  };
}
