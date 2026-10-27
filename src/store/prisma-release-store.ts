import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { compareVersions } from "#src/semver";
import type {
  OrgKey,
  PutNotesInput,
  ReleaseNotes,
  ReleaseStore,
  StoredRelease,
} from "./release-store";

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Notes as an object whose keys are in one fixed order: UTF-16 code unit order of the locale, so
 * the order does not depend on how they were sent or stored, nor on the database's collation.
 */
function sortedNotes(entries: Iterable<readonly [string, string]>): ReleaseNotes {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function createPrismaReleaseStore(db: PrismaClient): ReleaseStore {
  // Orgs are never deleted, so an id found or created stays right. Only hits are remembered:
  // a Workspace without an org may get one from another instance at any moment.
  const orgIds = new Map<string, string>();
  const remember = ({ issuer, workspaceId }: OrgKey, id: string) => {
    orgIds.set(`${issuer}\n${workspaceId}`, id);
    return id;
  };

  const writeNotes = ({ orgId, app, version, channel, agentId, notes }: PutNotesInput) =>
    db.$transaction(async (tx) => {
      const sorted = sortedNotes(Object.entries(notes));
      // Upserting the release first takes its row lock, so concurrent puts of one version
      // are applied one after the other, each replacing the whole set.
      const release = await tx.release.upsert({
        where: { orgId_app_version: { orgId, app, version } },
        create: {
          orgId,
          app,
          version,
          channel,
          createdByAgentId: agentId,
          updatedByAgentId: agentId,
        },
        update: { channel, updatedByAgentId: agentId },
        select: { id: true, updatedAt: true },
      });
      await tx.releaseNote.deleteMany({ where: { releaseId: release.id } });
      await tx.releaseNote.createMany({
        data: Object.entries(sorted).map(([locale, body]) => ({
          releaseId: release.id,
          locale,
          body,
        })),
      });
      return { app, version, channel, notes: sorted, updatedAt: release.updatedAt };
    });

  const store: ReleaseStore = {
    async findOrg(key) {
      const known = orgIds.get(`${key.issuer}\n${key.workspaceId}`);
      if (known) return known;
      const org = await db.org.findUnique({
        where: { issuer_workspaceId: { issuer: key.issuer, workspaceId: key.workspaceId } },
        select: { id: true },
      });
      return org ? remember(key, org.id) : null;
    },

    async ensureOrg(key) {
      const existing = await store.findOrg(key);
      if (existing) return existing;
      try {
        const org = await db.org.create({
          data: { issuer: key.issuer, workspaceId: key.workspaceId },
          select: { id: true },
        });
        return remember(key, org.id);
      } catch (error) {
        // Another first call created it between our read and our insert (unique violation).
        if (!isUniqueViolation(error)) throw error;
        const created = await store.findOrg(key);
        if (!created) throw error;
        return created;
      }
    },

    async putNotes(input) {
      try {
        return await writeNotes(input);
      } catch (error) {
        // Two first puts of a new version can both try to create the release. The loser's
        // transaction is void, so run it again: the release now exists and its row lock orders them.
        if (!isUniqueViolation(error)) throw error;
        return writeNotes(input);
      }
    },

    async getRelease(orgId, app, version): Promise<StoredRelease | null> {
      const release = await db.release.findUnique({
        where: { orgId_app_version: { orgId, app, version } },
        include: { notes: true },
      });
      if (!release) return null;
      return {
        app: release.app,
        version: release.version,
        channel: release.channel,
        notes: sortedNotes(release.notes.map((row) => [row.locale, row.body])),
        updatedAt: release.updatedAt,
      };
    },

    async listReleases(orgId, app, { channel, limit }) {
      // SemVer precedence is not a SQL ordering, so the app's releases are sorted here. Fine
      // while an app has hundreds of versions; store a sort key if it ever has many more.
      const releases = await db.release.findMany({
        where: { orgId, app, ...(channel && { channel }) },
        select: {
          version: true,
          channel: true,
          updatedAt: true,
          notes: { select: { locale: true } },
        },
      });
      return releases
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, limit)
        .map(({ notes, ...release }) => ({
          ...release,
          locales: notes.map((note) => note.locale).sort(),
        }));
    },
  };
  return store;
}
