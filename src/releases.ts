import type { HandlerContext, HandlerResponse, Handlers } from "./app";
import { LIST_DEFAULT_LIMIT } from "./manifest";
import { invalidInput } from "./responses";
import { parseSemVer } from "./semver";
import type { ReleaseChannel, ReleaseStore, StoredRelease } from "./store/release-store";

/** A version with a prerelease part (0.1.3-dev.4) is a dev build; any other is stable. */
export function channelOf(version: string): ReleaseChannel {
  return (parseSemVer(version)?.prerelease.length ?? 0) > 0 ? "dev" : "stable";
}

/** The wire form of a stored value: its `updatedAt` as an ISO string. The one place that does it. */
const toWire = <T extends { updatedAt: Date }>(value: T) => ({
  ...value,
  updatedAt: value.updatedAt.toISOString(),
});

/** The wire form of a stored release, as the public endpoint returns it. */
export const releaseBody = (release: StoredRelease) => toWire(release);

/**
 * Trims each text and writes each locale in its canonical form (zh-cn becomes zh-CN), which the
 * schema's pattern cannot do. Refuses a tag that is not a valid language tag and keys that are
 * the same locale once canonical.
 */
function canonicalNotes(
  notes: Record<string, string>,
): { notes: Record<string, string> } | { problems: string[] } {
  const canonical: Record<string, string> = {};
  const sentAs = new Map<string, string>();
  const problems: string[] = [];
  for (const [locale, text] of Object.entries(notes)) {
    let tag: string | undefined;
    try {
      tag = Intl.getCanonicalLocales(locale)[0];
    } catch {
      problems.push(`notes locale ${JSON.stringify(locale)} is not a valid language tag`);
      continue;
    }
    if (tag === undefined) continue;
    const earlier = sentAs.get(tag);
    if (earlier !== undefined) {
      problems.push(
        `notes locales ${JSON.stringify(earlier)} and ${JSON.stringify(locale)} are both ${JSON.stringify(tag)} in canonical form`,
      );
      continue;
    }
    sentAs.set(tag, locale);
    canonical[tag] = text.trim();
  }
  return problems.length > 0 ? { problems } : { notes: canonical };
}

const notFound = (): HandlerResponse => ({
  status: 404,
  body: { error: "not_found", message: "No such release" },
});

/**
 * Handlers of the release actions in the manifest. The pipeline in app.ts has validated the input
 * and resolved the caller's org (`caller.orgId`): found, for a read, so a read never creates an org
 * (null when the Workspace has none); found or created, for a write. Every query is scoped to it.
 */
export function createReleaseHandlers(
  store: ReleaseStore,
  publicUrlOf: (orgId: string, release: StoredRelease) => string,
): Handlers {
  /** What notes.put and notes.get return: the release plus where it is public. */
  const withLocation = (orgId: string, release: StoredRelease) => ({
    ...releaseBody(release),
    orgId,
    publicUrl: publicUrlOf(orgId, release),
  });

  return {
    "releases.notes.put": async (
      input: { app: string; version: string; notes: Record<string, string> },
      { orgId, agentId }: HandlerContext,
    ) => {
      if (!orgId) throw new Error("A write reached its handler without an org");
      // The schema has checked the version and the notes; what is left is trimming and canonical locales.
      const canonical = canonicalNotes(input.notes);
      if ("problems" in canonical) return invalidInput(canonical.problems);
      const notes = canonical.notes;
      const release = await store.putNotes({
        orgId,
        app: input.app,
        version: input.version,
        channel: channelOf(input.version),
        agentId,
        notes,
      });
      return { status: 200, body: withLocation(orgId, release) };
    },

    "releases.notes.get": async (
      input: { app: string; version: string },
      { orgId }: HandlerContext,
    ) => {
      const release = orgId ? await store.getRelease(orgId, input.app, input.version) : null;
      return release ? { status: 200, body: withLocation(orgId as string, release) } : notFound();
    },

    "releases.list": async (
      input: { app: string; channel?: ReleaseChannel; limit?: number },
      { orgId }: HandlerContext,
    ) => {
      const releases = orgId
        ? await store.listReleases(orgId, input.app, {
            channel: input.channel,
            limit: input.limit ?? LIST_DEFAULT_LIMIT,
          })
        : [];
      return {
        status: 200,
        body: {
          releases: releases.map(toWire),
        },
      };
    },
  };
}
