import { createHash } from "node:crypto";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

/** Stable fingerprint of a request's input, independent of property order. */
const fingerprint = (input) => createHash("sha256").update(canonical(input)).digest("hex");
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
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
export function createIdempotencyStore(now = Date.now) {
  const entries = new Map();
  const id = (scope, key) => `${scope}\n${key}`;
  return {
    /** @returns {{ state: "new" } | { state: "replay", response: { status: number, body: unknown } } | { state: "in_flight" } | { state: "conflict" }} */
    begin(scope, key, input) {
      const entry = entries.get(id(scope, key));
      const print = fingerprint(input);
      if (entry && entry.expiresAt >= now()) {
        if (entry.fingerprint !== print) return { state: "conflict" };
        return entry.response ? { state: "replay", response: entry.response } : { state: "in_flight" };
      }
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
      entries.set(id(scope, key), { fingerprint: print, response: undefined, expiresAt: now() + TTL_MS });
      return { state: "new" };
    },
    complete(scope, key, response) {
      const entry = entries.get(id(scope, key));
      if (entry) entry.response = response;
    },
    release(scope, key) {
      entries.delete(id(scope, key));
    },
  };
}
