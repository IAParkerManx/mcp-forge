// Drift: compare a live value against the output schema inferred at
// investigation time. Missing required fields and type changes break callers;
// new fields are additive and only mean the schema is out of date.
import type { JsonSchema } from "../ir/types.ts";

export interface Drift {
  /** Required fields absent from the live value. */
  missing: string[];
  /** Fields whose live type differs from every type the schema allows. */
  changed: { path: string; expected: string; actual: string }[];
  /** Fields present live but unknown to the schema. */
  added: string[];
}

export const emptyDrift = (): Drift => ({ missing: [], changed: [], added: [] });

export function isBreaking(d: Drift): boolean {
  return d.missing.length > 0 || d.changed.length > 0;
}

export function hasDrift(d: Drift): boolean {
  return isBreaking(d) || d.added.length > 0;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function allowedTypes(schema: JsonSchema): string[] | undefined {
  if (Array.isArray(schema.anyOf)) {
    const nested = (schema.anyOf as JsonSchema[]).map(allowedTypes);
    return nested.some((t) => t === undefined) ? undefined : nested.flat() as string[];
  }
  if (schema.type === undefined) return undefined; // anything goes
  return Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
}

function accepts(types: string[], actual: string): boolean {
  return types.includes(actual) || (actual === "integer" && types.includes("number"));
}

const MAX_ITEMS = 50;

/** Walk a live value against a schema, collecting drift with dotted paths (`items[].color`). */
export function driftOf(schema: JsonSchema | undefined, value: unknown, path = "", into: Drift = emptyDrift()): Drift {
  if (!schema) return into;
  const types = allowedTypes(schema);
  const actual = typeOf(value);
  const here = path || "(root)";
  if (types && !accepts(types, actual)) {
    into.changed.push({ path: here, expected: types.join("|"), actual });
    return into;
  }
  if (actual === "object" && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    const obj = value as Record<string, unknown>;
    for (const name of (schema.required ?? []) as string[]) {
      if (!(name in obj)) into.missing.push(path ? `${path}.${name}` : name);
    }
    for (const [name, child] of Object.entries(obj)) {
      const childPath = path ? `${path}.${name}` : name;
      if (props[name]) driftOf(props[name], child, childPath, into);
      else if (!into.added.includes(childPath)) into.added.push(childPath);
    }
  } else if (actual === "array" && schema.items) {
    for (const item of (value as unknown[]).slice(0, MAX_ITEMS)) driftOf(schema.items as JsonSchema, item, `${path}[]`, into);
  }
  return into;
}

/** Merge drift from several replays of one tool, without duplicates. */
export function mergeDrift(a: Drift, b: Drift): Drift {
  const uniq = <T>(xs: T[], key: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i);
  return {
    missing: uniq([...a.missing, ...b.missing], (x) => x),
    changed: uniq([...a.changed, ...b.changed], (x) => `${x.path}:${x.actual}`),
    added: uniq([...a.added, ...b.added], (x) => x),
  };
}
