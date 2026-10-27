import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { actions, buildManifest } from "../src/manifest.js";

const schema = JSON.parse(
  readFileSync(new URL("./fixtures/coforge-agent-manifest.v1.schema.json", import.meta.url), "utf8"),
);
const manifest = buildManifest({ appOrigin: "https://notes.example.com" });

test("the manifest validates against the published coforge-agent-manifest.v1 schema", () => {
  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
  const validateManifest = ajv.compile(schema);
  assert.ok(validateManifest(manifest), JSON.stringify(validateManifest.errors, null, 2));
});

test("the schema rejects a manifest that breaks it", () => {
  const ajv = addFormats(new Ajv2020({ strict: false }));
  const validateManifest = ajv.compile(schema);
  assert.equal(validateManifest({ ...manifest, schema: "other" }), false);
  assert.equal(validateManifest({ ...manifest, surprise: 1 }), false);
});

// The rules the JSON Schema cannot state (docs: "Actions and schemas").
test("actions are coherent", () => {
  const names = actions.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "action names are unique");
  for (const a of actions) {
    if (a.endpoint.method === "GET") assert.equal(a.effect, "read", `${a.name}: GET means read`);
    if (a.effect === "read") {
      assert.equal(a.endpoint.method, "GET");
      assert.equal(a.idempotency, "safe");
    }
    if (a.idempotency === "safe") assert.equal(a.effect, "read", `${a.name}: only read may be safe`);
    if (a.effect === "delete") assert.equal(a.endpoint.method, "DELETE");
    assert.equal(a.idempotency === "key_required", "idempotency_header" in a, `${a.name}: header iff key_required`);
    assert.deepEqual([...a.required_scopes], [...a.required_scopes].sort(), `${a.name}: scopes sorted`);
    assert.equal(a.input_schema.type, "object");
    for (const [, param] of a.endpoint.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      assert.ok(a.input_schema.required?.includes(param), `${a.name}: {${param}} is a required input`);
      assert.ok(["string", "integer", "number", "boolean"].includes(a.input_schema.properties[param]?.type));
    }
  }
});

test("a GET and a key_required action are both present", () => {
  assert.ok(actions.some((a) => a.endpoint.method === "GET" && a.idempotency === "safe"));
  assert.ok(actions.some((a) => a.idempotency === "key_required"));
});
