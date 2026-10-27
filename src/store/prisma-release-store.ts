import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { compareVersions } from "#src/semver";
import type { OrgKey, ReleaseNotes, ReleaseStore, StoredRelease } from "./release-store";

function toNotes(rows: { locale: string; body: string }[]): ReleaseNotes {
  return Object.fromEntries(rows.map((row) => [row.locale, row.body]));
}

export function createPrismaReleaseStore(db: PrismaClient): ReleaseStore {
  // Orgs are never deleted, so an id found or created stays right. Only hits are remembered:
  // a Workspace without an org may get one from another instance at any moment.
  const orgIds = new Map<string, string>();
  const remember = ({ issuer, workspaceId }: OrgKey, id: string) => {
    orgIds.set(`${issuer}\n${workspaceId}`, id);
    return id;
  };

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
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        const created = await store.findOrg(key);
        if (!created) throw error;
        return created;
      }
    },

    putNotes({ orgId, app, version, channel, agentId, notes }) {
      return db.$transaction(async (tx) => {
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
          data: Object.entries(notes).map(([locale, body]) => ({
            releaseId: release.id,
            locale,
            body,
          })),
        });
        return { app, version, channel, notes, updatedAt: release.updatedAt };
      });
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
        notes: toNotes(release.notes),
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
