/**
 * The Agent manifest (coforge-agent-manifest.v1) and the single source of truth for the
 * service's routes: app.ts builds its routes, input checks and scope checks from `actions`.
 * `required_scopes` are Login with CoForge scopes (openid, profile, identity, email), not scopes this
 * app invents: `coforge app invoke` asks for a token of exactly those (plus the fixed openid, profile
 * and identity), so list only what the action truly needs. `[]` means identity only. Authorization
 * beyond that (which Workspace's releases) is the app's own business: see the handlers in releases.ts.
 * Agents read this document; keep descriptions plain and factual.
 */

import type { Config } from "./config";
import { SEMVER_PATTERN } from "./semver";
import type { Schema } from "./validate";

/**
 * An action as Ship declares it. No `key_required` action exists: that needs a database-backed
 * idempotency store (see AGENTS.md), so the type does not allow it or an `idempotency_header`.
 */
export type Action = {
  name: string;
  description?: string;
  effect: "read" | "create" | "update" | "delete" | "external_side_effect";
  endpoint: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };
  idempotency: "safe" | "idempotent" | "non_idempotent";
  required_scopes: readonly string[];
  input_schema: Schema;
  output_schema?: Schema;
};

export const MANIFEST_PATH = "/.well-known/coforge-agent-manifest.json";
export const API_PREFIX = "/api";

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;

/** An app's slug. Shared with the public route, which validates its `app` segment with it. */
export const APP_SCHEMA: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
  description: "The app's slug: lower-case letters, digits and dashes, such as coforge-computer.",
};

/** A SemVer 2.0.0 version. Shared with the public route. */
export const VERSION_SCHEMA: Schema = {
  type: "string",
  minLength: 5,
  maxLength: 128,
  pattern: SEMVER_PATTERN,
  description:
    "A SemVer 2.0.0 version, such as 1.4.0 or 0.1.3-dev.4. A prerelease part puts it on the dev channel.",
};

const app = APP_SCHEMA;
const version = VERSION_SCHEMA;

const NOTES_SCHEMA: Schema = {
  type: "object",
  description:
    'Markdown by locale, such as {"en": "...", "zh-CN": "..."}. 1 to 20 locales; a locale is a language tag such as en or zh-CN; each text has 1 to 16000 characters and some non-whitespace. Ship trims each text before storing it.',
  minProperties: 1,
  maxProperties: 20,
  propertyNames: { pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$" },
  additionalProperties: { type: "string", minLength: 1, maxLength: 16000, pattern: "\\S" },
};

const channel = { type: "string", enum: ["dev", "stable"] } as const;

const notesOutput = {
  type: "object",
  properties: {
    app: { type: "string" },
    version: { type: "string" },
    channel,
    notes: { type: "object", additionalProperties: true },
    updatedAt: { type: "string" },
    orgId: {
      type: "string",
      description: "The id of Ship's org for this Workspace, as used in publicUrl.",
    },
    publicUrl: {
      type: "string",
      description: "Where these notes are public, readable without a token.",
    },
  },
} as const;

export const actions: Action[] = [
  {
    name: "releases.notes.put",
    description:
      "Set the release notes of one app version, one Markdown text per locale. Replaces all of the version's notes: locales not sent are removed.",
    effect: "update",
    endpoint: { method: "PUT", path: "/apps/{app}/releases/{version}/notes" },
    idempotency: "idempotent",
    required_scopes: [],
    input_schema: {
      type: "object",
      properties: {
        app,
        version,
        notes: NOTES_SCHEMA,
      },
      required: ["app", "version", "notes"],
      additionalProperties: false,
    },
    output_schema: notesOutput,
  },
  {
    name: "releases.notes.get",
    description:
      "Read the release notes of one app version, by locale. 404 not_found when there are none.",
    effect: "read",
    endpoint: { method: "GET", path: "/apps/{app}/releases/{version}/notes" },
    idempotency: "safe",
    required_scopes: [],
    input_schema: {
      type: "object",
      properties: { app, version },
      required: ["app", "version"],
      additionalProperties: false,
    },
    output_schema: notesOutput,
  },
  {
    name: "releases.list",
    description:
      "List the versions of an app that have release notes, newest first by SemVer precedence, with the locales each has.",
    effect: "read",
    endpoint: { method: "GET", path: "/apps/{app}/releases" },
    idempotency: "safe",
    required_scopes: [],
    input_schema: {
      type: "object",
      properties: {
        app,
        channel: { ...channel, description: "Only releases of this channel." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LIST_MAX_LIMIT,
          default: LIST_DEFAULT_LIMIT,
          description: "How many releases to return.",
        },
      },
      required: ["app"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        releases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              version: { type: "string" },
              channel,
              locales: { type: "array", items: { type: "string" } },
              updatedAt: { type: "string" },
            },
          },
        },
      },
    },
  },
];

/**
 * Ship validates more than the manifest's schema subset can say: `additionalProperties` as a schema,
 * `propertyNames`, `minProperties` and `maxProperties` (see validate.ts). CoForge rejects a manifest
 * with any of those keywords, so the published schema keeps the subset (`additionalProperties`
 * becomes `true`) and carries each dropped keyword under an `x-` name, which CoForge ignores.
 */
export function publishedSchema(schema: Schema): Schema {
  const {
    properties,
    items,
    additionalProperties,
    propertyNames,
    minProperties,
    maxProperties,
    ...rest
  } = schema;
  const published: Schema = { ...rest };
  if (properties) {
    published.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [name, publishedSchema(child)]),
    );
  }
  if (items) published.items = publishedSchema(items);
  if (typeof additionalProperties === "boolean")
    published.additionalProperties = additionalProperties;
  else if (additionalProperties) {
    published.additionalProperties = true;
    published["x-additionalProperties"] = additionalProperties;
  }
  if (propertyNames) published["x-propertyNames"] = propertyNames;
  if (minProperties !== undefined) published["x-minProperties"] = minProperties;
  if (maxProperties !== undefined) published["x-maxProperties"] = maxProperties;
  return published;
}

export function buildManifest(config: Pick<Config, "appOrigin">, served: Action[] = actions) {
  return {
    schema: "coforge-agent-manifest.v1",
    name: "Ship",
    description:
      "Stores release notes per app version and locale, and lists an app's releases newest first.",
    app_origin: config.appOrigin,
    execution: { mode: "http_api", base_url: `${config.appOrigin}${API_PREFIX}` },
    auth: { type: "login_with_coforge" },
    actions: served.map((action) => ({
      ...action,
      input_schema: publishedSchema(action.input_schema),
      ...(action.output_schema && { output_schema: publishedSchema(action.output_schema) }),
    })),
  };
}
