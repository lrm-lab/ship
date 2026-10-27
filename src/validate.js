/**
 * Validates `value` against the manifest schema subset this template uses
 * (type, properties, required, additionalProperties, enum, const, min/max,
 * minLength/maxLength, items, minItems/maxItems). CoForge's CLI checks input too,
 * but the service must not trust its caller. Returns problem strings; [] means valid.
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function validate(schema, value, path = "") {
  const at = path || "input";
  const type = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const ok =
    type === undefined ||
    actual === type ||
    (type === "integer" && Number.isInteger(value)) ||
    (type === "number" && actual === "number" && Number.isFinite(value));
  if (!ok) return [`${at} must be ${type}`];

  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && value !== schema.const) problems.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => problems.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  if (actual === "object") {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) problems.push(`${path ? `${path}.` : ""}${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) problems.push(...validate(properties[name], item, `${path ? `${path}.` : ""}${name}`));
      else if (schema.additionalProperties === false) problems.push(`${path ? `${path}.` : ""}${name} is not allowed`);
    }
  }
  return problems;
}

const SCALAR = {
  integer: (v) => (/^-?\d+$/.test(v) ? Number(v) : v),
  number: (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v),
  boolean: (v) => (v === "true" ? true : v === "false" ? false : v),
};
const coerceScalar = (type, value) => (SCALAR[type] ? SCALAR[type](value) : value);

/**
 * A query string carries only text. Turn it back into what the action's input_schema declares,
 * the way `coforge app invoke` sent it: integers, numbers and booleans as decimal / true / false
 * literals, arrays as repeated names. Anything that does not parse stays a string and fails
 * validation. `queries` maps a name to all its values (Hono's `c.req.queries()`).
 * @param {Record<string, any>} schema
 * @param {Record<string, string[]>} queries
 */
export function coerceQuery(schema, queries) {
  const input = {};
  for (const [name, values] of Object.entries(queries)) {
    const declared = schema.properties?.[name];
    if (declared?.type === "array") input[name] = values.map((v) => coerceScalar(declared.items?.type, v));
    else input[name] = values.length === 1 ? coerceScalar(declared?.type, values[0]) : values;
  }
  return input;
}
