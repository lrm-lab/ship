import type { PrismaClient } from "#src/generated/prisma/client";
import type { ReleaseChannel, ReleaseNotes, ReleaseStore, StoredRelease } from "./release-store";

const compareLocale = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function toNotes(rows: { locale: string; body: string }[]): ReleaseNotes {
  return Object.fromEntries(rows.map((row) => [row.locale, row.body]));
}

export function createPrismaReleaseStore(db: PrismaClient): ReleaseStore {
  return {
    async ensureOrg({ issuer, workspaceId }) {
      const where = { issuer_workspaceId: { issuer, workspaceId } };
      // Read first: almost every call finds the org, and a read writes nothing.
      const existing = await db.org.findUnique({ where, select: { id: true } });
      if (existing) return existing.id;
      try {
        return (await db.org.create({ data: { issuer, workspaceId }, select: { id: true } })).id;
      } catch (error) {
        // Another first call created it between our read and our insert (unique violation).
        if ((error as { code?: string }).code !== "P2002") throw error;
        return (await db.org.findUniqueOrThrow({ where, select: { id: true } })).id;
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
        const locales = Object.keys(notes);
        await tx.releaseNote.deleteMany({
          where: { releaseId: release.id, locale: { notIn: locales } },
        });
        for (const locale of locales) {
          await tx.releaseNote.upsert({
            where: { releaseId_locale: { releaseId: release.id, locale } },
            create: { releaseId: release.id, locale, body: notes[locale] as string },
            update: { body: notes[locale] as string },
          });
        }
        return { app, version, channel, notes: { ...notes }, updatedAt: release.updatedAt };
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

    async listReleases(orgId, app, channel?: ReleaseChannel) {
      const releases = await db.release.findMany({
        where: { orgId, app, ...(channel ? { channel } : {}) },
        include: { notes: { select: { locale: true } } },
      });
      return releases.map((release) => ({
        version: release.version,
        channel: release.channel,
        locales: release.notes.map((note) => note.locale).sort(compareLocale),
        updatedAt: release.updatedAt,
      }));
    },
  };
}
