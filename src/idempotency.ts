import { createHash } from "node:crypto";

export type StoredResponse = { status: number; body: unknown };
type Begin =
  | { state: "new" }
  | { state: "replay"; response: StoredResponse }
  | { state: "in_flight" }
  | { state: "conflict" };

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

/** Stable fingerprint of a request's input, independent of property order. */
const fingerprint = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/**
 * Makes a key_required action run at most once per Idempotency-Key. The key is reserved
 * *before* the handler runs, so a duplicate that arrives while the first call is still
 * working is not run a second time: `begin` answers "in_flight" and the caller replies 409
 * with Retry-After (the CLI's retry then replays the finished answer). Only a 2xx answer is
 * kept; a failed or thrown call releases the key so a retry can run. Reusing a key with
 * different input is a "conflict". The key is scoped by the caller (Workspace, Agent, action).
 * In memory: back it with a database or Redis before running several instances.
 */
export function createIdempotencyStore(now: () => number = Date.now) {
  const entries = new Map<
    string,
    { fingerprint: string; response: StoredResponse | undefined; expiresAt: number }
  >();
  const id = (scope: string, key: string) => `${scope}\n${key}`;
  return {
    begin(scope: string, key: string, input: unknown): Begin {
      const entry = entries.get(id(scope, key));
      const print = fingerprint(input);
      if (entry && entry.expiresAt >= now()) {
        if (entry.fingerprint !== print) return { state: "conflict" };
        return entry.response
          ? { state: "replay", response: entry.response }
          : { state: "in_flight" };
      }
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      entries.set(id(scope, key), {
        fingerprint: print,
        response: undefined,
        expiresAt: now() + TTL_MS,
      });
      return { state: "new" };
    },
    complete(scope: string, key: string, response: StoredResponse) {
      const entry = entries.get(id(scope, key));
      if (entry) entry.response = response;
    },
    release(scope: string, key: string) {
      entries.delete(id(scope, key));
    },
  };
}
