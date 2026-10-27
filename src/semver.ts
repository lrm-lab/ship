/** A parsed SemVer 2.0.0 version (https://semver.org/). Numbers stay text so none loses precision. */
export type SemVer = {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
};

/**
 * The regular expression published on semver.org, with \d written as [0-9] so only ASCII digits match
 * and the build metadata not captured. Its source is also the manifest's `pattern` for a version.
 */
export const SEMVER_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$";
const SEMVER = new RegExp(SEMVER_PATTERN, "u");

/** The parts of a valid SemVer 2.0.0 string, or null when it is not one (no leading `v`, no spaces). */
export function parseSemVer(text: string): SemVer | null {
  const match = SEMVER.exec(text);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: major as string,
    minor: minor as string,
    patch: patch as string,
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

const isNumeric = (identifier: string) => /^[0-9]+$/.test(identifier);

/** Digit strings without leading zeros order by length, then text. */
function compareNumbers(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = isNumeric(a);
  const bNumeric = isNumeric(b);
  if (aNumeric && bNumeric) return compareNumbers(a, b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1; // numeric identifiers are lower
  return a < b ? -1 : a > b ? 1 : 0; // ASCII order
}

/** SemVer precedence (spec item 11): negative if a is lower than b, 0 if equal, positive if higher. Build metadata is ignored. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const part of ["major", "minor", "patch"] as const) {
    const result = compareNumbers(a[part], b[part]);
    if (result !== 0) return result;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A version without a prerelease part is higher than one with it.
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const result = compareIdentifiers(a.prerelease[i] as string, b.prerelease[i] as string);
    if (result !== 0) return result;
  }
  return a.prerelease.length - b.prerelease.length; // a larger set of fields is higher
}

/**
 * Orders version strings, lowest first: by SemVer precedence, then by text, so versions that differ
 * only in build metadata (equal precedence) still have one fixed order. The strings must be valid
 * SemVer; Ship only stores versions it has validated.
 */
export function compareVersions(a: string, b: string): number {
  const byPrecedence = compareSemVer(parseSemVer(a) as SemVer, parseSemVer(b) as SemVer);
  return byPrecedence || (a < b ? -1 : a > b ? 1 : 0);
}
