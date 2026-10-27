export type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
  [key: string]: unknown;
};

/**
 * Validates `value` against the manifest schema subset this template uses
 * (type, properties, required, additionalProperties, enum, const, min/max,
 * minLength/maxLength, items, minItems/maxItems). CoForge's CLI checks input too,
 * but the service must not trust its caller. Returns problem strings; [] means valid.
 */
export function validate(schema: Schema, value: unknown, path = ""): string[] {
  const at = path || "input";
  const type = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const ok =
    type === undefined ||
    actual === type ||
    (type === "integer" && Number.isInteger(value)) ||
    (type === "number" && actual === "number" && Number.isFinite(value));
  if (!ok) return [`${at} must be ${type}`];

  const problems: string[] = [];
  if (schema.enum && !schema.enum.includes(value as string))
    problems.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && value !== schema.const)
    problems.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      problems.push(`${at} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      problems.push(`${at} is longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      problems.push(`${at} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      problems.push(`${at} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      problems.push(`${at} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      problems.push(`${at} has more than ${schema.maxItems} items`);
    const items = schema.items;
    if (items) value.forEach((item, i) => problems.push(...validate(items, item, `${at}[${i}]`)));
  }
  if (actual === "object") {
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const prefix = path ? `${path}.` : "";
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(object, name)) problems.push(`${prefix}${name} is required`);
    }
    for (const [name, item] of Object.entries(object)) {
      const declared = Object.hasOwn(properties, name) ? properties[name] : undefined;
      if (declared) problems.push(...validate(declared, item, `${prefix}${name}`));
      else if (schema.additionalProperties === false)
        problems.push(`${prefix}${name} is not allowed`);
    }
  }
  return problems;
}

const SCALAR: Record<string, (v: string) => string | number | boolean> = {
  integer: (v) => (/^-?\d+$/.test(v) ? Number(v) : v),
  number: (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v),
  boolean: (v) => (v === "true" ? true : v === "false" ? false : v),
};
const coerceScalar = (type: string | undefined, value: string) =>
  type && SCALAR[type] ? SCALAR[type](value) : value;

/**
 * A query string carries only text. Turn it back into what the action's input_schema declares,
 * the way `coforge app invoke` sent it: integers, numbers and booleans as decimal / true / false
 * literals, arrays as repeated names. Anything that does not parse stays a string and fails
 * validation. `queries` maps a name to all its values (Hono's `c.req.queries()`).
 */
export function coerceQuery(schema: Schema, queries: Record<string, string[]>) {
  const input: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(queries)) {
    const declared = schema.properties?.[name];
    if (declared?.type === "array")
      input[name] = values.map((v) => coerceScalar(declared.items?.type, v));
    else
      input[name] =
        values.length === 1 ? coerceScalar(declared?.type, values[0] as string) : values;
  }
  return input;
}
