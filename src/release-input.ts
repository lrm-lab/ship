import { APP_NAME_PATTERN, LOCALE_PATTERN, NOTES_MAX_LENGTH, NOTES_MAX_LOCALES } from "./manifest";
import type { ReleaseChannel, ReleaseNotes } from "./store/release-store";
import { parseSemVer } from "./semver";

const APP_NAME = new RegExp(APP_NAME_PATTERN);
const LOCALE = new RegExp(LOCALE_PATTERN);
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAppName = (value: string) => APP_NAME.test(value);
export const isOrgId = (value: string) => ORG_ID.test(value);
export const isVersion = (value: string) => parseSemVer(value) !== null;

/** A version with a prerelease part (0.1.3-dev.4) is a dev build; any other is stable. */
export function channelOf(version: string): ReleaseChannel {
  return (parseSemVer(version)?.prerelease.length ?? 0) > 0 ? "dev" : "stable";
}

/**
 * Checks and normalizes the `notes` input: 1 to 20 locales, each text trimmed and 1 to 16000
 * characters (JavaScript string length). Returns the trimmed notes, or what is wrong.
 */
export function parseNotes(value: unknown): { notes: ReleaseNotes } | { problems: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { problems: ["notes must be an object of locale to Markdown text"] };
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > NOTES_MAX_LOCALES) {
    return { problems: [`notes must have 1 to ${NOTES_MAX_LOCALES} locales`] };
  }
  const problems: string[] = [];
  const notes: ReleaseNotes = {};
  for (const [locale, text] of entries) {
    if (!LOCALE.test(locale)) {
      problems.push(`notes locale ${JSON.stringify(locale)} must match ${LOCALE_PATTERN}`);
      continue;
    }
    if (typeof text !== "string") {
      problems.push(`notes.${locale} must be a string`);
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > NOTES_MAX_LENGTH) {
      problems.push(`notes.${locale} must be 1 to ${NOTES_MAX_LENGTH} characters after trimming`);
      continue;
    }
    notes[locale] = trimmed;
  }
  return problems.length > 0 ? { problems } : { notes };
}
