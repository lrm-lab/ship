/**
 * The Agent manifest (coforge-agent-manifest.v1) and the single source of truth for the
 * service's routes: app.js builds its routes, input checks and scope checks from `actions`.
 * `required_scopes` are Login with CoForge scopes (openid, profile, identity, email), not scopes this
 * app invents: `coforge app invoke` asks for a token of exactly those (plus the fixed openid, profile
 * and identity), so list only what the action truly needs. `[]` means identity only. Authorization
 * beyond that (who may touch which note) is the app's own business: see the handlers in app.js.
 * Agents read this document; keep descriptions plain and factual.
 */

import type { Config } from "./config";
import type { Schema } from "./validate";

type ActionBase = {
  name: string;
  description?: string;
  effect: "read" | "create" | "update" | "delete" | "external_side_effect";
  endpoint: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };
  required_scopes: readonly string[];
  input_schema: Schema;
  output_schema?: Schema;
};

/** `idempotency_header` exists exactly when the action is `key_required`. */
export type Action = ActionBase &
  (
    | { idempotency: "key_required"; idempotency_header: string }
    | { idempotency: "safe" | "idempotent" | "non_idempotent"; idempotency_header?: undefined }
  );

export const MANIFEST_PATH = "/.well-known/coforge-agent-manifest.json";
export const API_PREFIX = "/api";

export const actions: Action[] = [
  {
    name: "notes.get",
    description: "Read one note by id.",
    effect: "read",
    endpoint: { method: "GET", path: "/notes/{id}" },
    idempotency: "safe",
    required_scopes: [],
    input_schema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["id"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "notes.create",
    description: "Create a note. Send the same Idempotency-Key to retry safely.",
    effect: "create",
    endpoint: { method: "POST", path: "/notes" },
    idempotency: "key_required",
    idempotency_header: "Idempotency-Key",
    required_scopes: [],
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 5000 },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
    },
  },
];

export function buildManifest(config: Pick<Config, "appOrigin">) {
  return {
    schema: "coforge-agent-manifest.v1",
    name: "Ship",
    description: "Stores release notes per app version and locale, and lists an app's releases.",
    app_origin: config.appOrigin,
    execution: { mode: "http_api", base_url: `${config.appOrigin}${API_PREFIX}` },
    auth: { type: "login_with_coforge" },
    actions,
  };
}
