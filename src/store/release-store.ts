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

/** Everything Ship keeps. Every release belongs to an org: a query never crosses orgs. */
export interface ReleaseStore {
  /** The id of the org of this Workspace, created on first use. */
  ensureOrg(key: OrgKey): Promise<string>;
  /** Creates the release or updates it, and replaces its whole set of notes. */
  putNotes(input: PutNotesInput): Promise<StoredRelease>;
  getRelease(orgId: string, app: string, version: string): Promise<StoredRelease | null>;
  /** Every release of the app (in no particular order), optionally of one channel. */
  listReleases(orgId: string, app: string, channel?: ReleaseChannel): Promise<ReleaseSummary[]>;
}
