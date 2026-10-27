import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { actions, buildManifest } from "#src/manifest";

const schema = JSON.parse(
  readFileSync(
    new URL("./fixtures/coforge-agent-manifest.v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const manifest = buildManifest({ appOrigin: "https://notes.example.com" });

test("the manifest validates against the published coforge-agent-manifest.v1 schema", () => {
  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
  const validateManifest = ajv.compile(schema);
  expect(validateManifest(manifest)).toBeTruthy();
});

test("the schema rejects a manifest that breaks it", () => {
  const ajv = addFormats(new Ajv2020({ strict: false }));
  const validateManifest = ajv.compile(schema);
  expect(validateManifest({ ...manifest, schema: "other" })).toBe(false);
  expect(validateManifest({ ...manifest, surprise: 1 })).toBe(false);
});

// The rules the JSON Schema cannot state (docs: "Actions and schemas").
test("actions are coherent", () => {
  const names = actions.map((a) => a.name);
  expect(new Set(names).size).toBe(names.length);
  for (const a of actions) {
    if (a.endpoint.method === "GET") expect(a.effect).toBe("read");
    if (a.effect === "read") {
      expect(a.endpoint.method).toBe("GET");
      expect(a.idempotency).toBe("safe");
    }
    if (a.idempotency === "safe") expect(a.effect).toBe("read");
    if (a.effect === "delete") expect(a.endpoint.method).toBe("DELETE");
    expect(a.idempotency === "key_required").toBe("idempotency_header" in a);
    expect([...a.required_scopes]).toEqual([...a.required_scopes].sort());
    expect(a.input_schema.type).toBe("object");
    for (const [, param] of a.endpoint.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      expect(a.input_schema.required?.includes(param!)).toBeTruthy();
      expect(
        ["string", "integer", "number", "boolean"].includes(
          a.input_schema.properties?.[param!]?.type ?? "",
        ),
      ).toBeTruthy();
    }
  }
});

test("Ship's actions are the three release actions, none needing a scope", () => {
  expect(actions.map((a) => [a.name, a.endpoint.method, a.effect, a.idempotency])).toEqual([
    ["releases.notes.put", "PUT", "update", "idempotent"],
    ["releases.notes.get", "GET", "read", "safe"],
    ["releases.list", "GET", "read", "safe"],
  ]);
  for (const a of actions) expect(a.required_scopes).toEqual([]);
  expect(manifest.name).toBe("Ship");
});
