import { describe, expect, test } from "bun:test";
import { validate, type Schema } from "#src/validate";

const notes: Schema = {
  type: "object",
  minProperties: 1,
  maxProperties: 2,
  propertyNames: { pattern: "^[a-z]{2}$" },
  additionalProperties: { type: "string", minLength: 1, maxLength: 5, pattern: "\\S" },
};

describe("validate: object keywords beyond the manifest subset", () => {
  test("accepts an object within every bound", () => {
    expect(validate(notes, { en: "hi", fr: "salut" }, "notes")).toEqual([]);
  });

  test("minProperties and maxProperties", () => {
    expect(validate(notes, {}, "notes")).toEqual(["notes has fewer than 1 properties"]);
    expect(validate(notes, { en: "a", fr: "b", de: "c" }, "notes")).toEqual([
      "notes has more than 2 properties",
    ]);
  });

  test("propertyNames applies a pattern to every key", () => {
    const problems = validate(notes, { EN: "a", fr: "b" }, "notes");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"EN"');
    expect(problems[0]).toContain("^[a-z]{2}$");
  });

  test("additionalProperties as a schema validates each undeclared property", () => {
    expect(validate(notes, { en: 5 }, "notes")).toEqual(["notes.en must be string"]);
    expect(validate(notes, { en: "toolong" }, "notes")).toEqual(["notes.en is longer than 5"]);
    expect(validate(notes, { en: "   " }, "notes")).toEqual(["notes.en must match \\S"]);
  });

  test("declared properties keep their own schema, others fall to additionalProperties", () => {
    const schema: Schema = {
      type: "object",
      properties: { id: { type: "integer" } },
      additionalProperties: { type: "string" },
    };
    expect(validate(schema, { id: 1, extra: "x" })).toEqual([]);
    expect(validate(schema, { id: "1", extra: 2 })).toEqual([
      "id must be integer",
      "extra must be string",
    ]);
  });

  test("additionalProperties false still refuses undeclared properties", () => {
    expect(validate({ type: "object", additionalProperties: false }, { x: 1 })).toEqual([
      "x is not allowed",
    ]);
  });

  test("a property named __proto__ is checked like any other", () => {
    const body = JSON.parse('{"__proto__": "x"}');
    expect(validate(notes, body, "notes")[0]).toContain("__proto__");
  });
});

describe("validate: pattern", () => {
  test("uses the u flag and rejects a non-matching string", () => {
    const schema: Schema = { type: "string", pattern: "^\\p{L}+$" };
    expect(validate(schema, "héllo")).toEqual([]);
    expect(validate(schema, "h3llo")).toEqual(["input must match ^\\p{L}+$"]);
  });
});
