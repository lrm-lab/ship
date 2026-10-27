import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { actions, buildManifest, publishedSchema } from "#src/manifest";

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
  const names = manifest.actions.map((a) => a.name);
  expect(new Set(names).size).toBe(names.length);
  for (const a of manifest.actions) {
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
  expect(manifest.actions.map((a) => [a.name, a.endpoint.method, a.effect, a.idempotency])).toEqual(
    [
      ["releases.notes.put", "PUT", "update", "idempotent"],
      ["releases.notes.get", "GET", "read", "safe"],
      ["releases.list", "GET", "read", "safe"],
    ],
  );
  for (const a of manifest.actions) expect(a.required_scopes).toEqual([]);
  expect(manifest.name).toBe("Ship");
});

test("the published schemas stay in CoForge's subset and carry Ship's extra rules under x- names", () => {
  const put = manifest.actions.find((a) => a.name === "releases.notes.put")!;
  const notes = put.input_schema.properties!.notes!;
  expect(notes.additionalProperties).toBe(true);
  expect(notes["x-minProperties"]).toBe(1);
  expect(notes["x-maxProperties"]).toBe(20);
  expect(notes["x-propertyNames"]).toEqual({ pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$" });
  expect(notes["x-additionalProperties"]).toMatchObject({ type: "string", maxLength: 16000 });
  // the service itself validates with the full rules
  const internal = actions.find((a) => a.name === "releases.notes.put")!.input_schema.properties!
    .notes!;
  expect(internal.minProperties).toBe(1);
  expect(typeof internal.additionalProperties).toBe("object");
  // the version is checked by the SemVer pattern, which CoForge never runs but the service does
  expect(put.input_schema.properties!.version!.pattern).toContain("(0|[1-9][0-9]*)");
});

test("publishedSchema keeps boolean additionalProperties and recurses into properties and items", () => {
  expect(
    publishedSchema({
      type: "object",
      properties: { list: { type: "array", items: { type: "object", minProperties: 1 } } },
      additionalProperties: false,
    }),
  ).toEqual({
    type: "object",
    properties: { list: { type: "array", items: { type: "object", "x-minProperties": 1 } } },
    additionalProperties: false,
  });
});
