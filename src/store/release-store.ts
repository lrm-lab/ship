export type ReleaseChannel = "dev" | "stable";

/** Release notes by locale (en, zh-CN, ...), each Markdown. */
export type ReleaseNotes = Record<string, string>;

export type StoredRelease = {
  app: string;
  version: string;
  channel: ReleaseChannel;
  notes: ReleaseNotes;
  updatedAt: Date;
};

export type ReleaseSummary = {
  version: string;
  channel: ReleaseChannel;
  /** The locales the release has notes in, sorted. */
  locales: string[];
  updatedAt: Date;
};

/** Who owns the data: one Workspace of one CoForge deployment. */
export type OrgKey = { issuer: string; workspaceId: string };

export type PutNotesInput = {
  orgId: string;
  app: string;
  version: string;
  channel: ReleaseChannel;
  agentId: string;
  notes: ReleaseNotes;
};

export type ListReleasesOptions = { channel?: ReleaseChannel; limit: number };

/** Everything Ship keeps. Every release belongs to an org: a query never crosses orgs. */
export interface ReleaseStore {
  /** The id of this Workspace's org, or null when it has none. Creates nothing. */
  findOrg(key: OrgKey): Promise<string | null>;
  /** The id of this Workspace's org, created on first use. */
  ensureOrg(key: OrgKey): Promise<string>;
  /** Creates the release or updates it, and replaces its whole set of notes. */
  putNotes(input: PutNotesInput): Promise<StoredRelease>;
  getRelease(orgId: string, app: string, version: string): Promise<StoredRelease | null>;
  /** The app's releases, newest first by SemVer precedence, at most `limit`, optionally of one channel. */
  listReleases(orgId: string, app: string, options: ListReleasesOptions): Promise<ReleaseSummary[]>;
}
