// JSON Schema inference from observed samples. Each sample widens the schema;
// `required` keeps only properties present in every sample, so a few samples
// produce a deliberately loose schema rather than an overconfident one.
import type { JsonSchema } from "../ir/types.ts";

type Kind = "null" | "boolean" | "integer" | "number" | "string" | "array" | "object";

interface Shape {
  kinds: Set<Kind>;
  count: number;
  strings: Map<string, number>;
  formats: Set<string | null>;
  items?: Shape;
  props?: Map<string, Shape>;
  /** Number of object samples, to decide which properties are always present. */
  objectCount: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URI = /^https?:\/\/\S+$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function stringFormat(value: string): string | null {
  if (UUID.test(value)) return "uuid";
  if (DATE_TIME.test(value)) return "date-time";
  if (DATE.test(value)) return "date";
  if (URI.test(value)) return "uri";
  if (EMAIL.test(value)) return "email";
  return null;
}

function emptyShape(): Shape {
  return { kinds: new Set(), count: 0, strings: new Map(), formats: new Set(), objectCount: 0 };
}

function kindOf(value: unknown): Kind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return "object";
}

function observe(shape: Shape, value: unknown): void {
  const kind = kindOf(value);
  shape.kinds.add(kind);
  shape.count += 1;
  if (kind === "string") {
    const s = value as string;
    shape.strings.set(s, (shape.strings.get(s) ?? 0) + 1);
    shape.formats.add(stringFormat(s));
  } else if (kind === "array") {
    shape.items ??= emptyShape();
    for (const item of value as unknown[]) observe(shape.items, item);
  } else if (kind === "object") {
    shape.props ??= new Map();
    shape.objectCount += 1;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      let child = shape.props.get(k);
      if (!child) shape.props.set(k, (child = emptyShape()));
      observe(child, v);
    }
  }
}

export interface InferOptions {
  /** Treat every property as optional (e.g. PATCH bodies). */
  allOptional?: boolean;
  /** Attach up to this many distinct observed string values as `examples`. */
  maxExamples?: number;
}

function toSchema(shape: Shape, options: InferOptions): JsonSchema {
  // A field only ever seen as null exists, but its type is unknown: accept anything.
  if (shape.kinds.size === 1 && shape.kinds.has("null")) return { description: "Only null was observed; the type is unknown." };
  const kinds = new Set(shape.kinds);
  if (kinds.has("integer") && kinds.has("number")) kinds.delete("integer");
  const schemas: JsonSchema[] = [];
  for (const kind of [...kinds].sort()) {
    if (kind === "object") {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [name, child] of [...(shape.props ?? new Map<string, Shape>())].sort(([a], [b]) => a.localeCompare(b))) {
        properties[name] = toSchema(child, { ...options, allOptional: false });
        // Each property shape counts one observation per object it appeared in.
        if (!options.allOptional && child.count === shape.objectCount) required.push(name);
      }
      schemas.push({ type: "object", properties, ...(required.length ? { required } : {}) });
    } else if (kind === "array") {
      schemas.push({ type: "array", items: shape.items && shape.items.count > 0 ? toSchema(shape.items, { ...options, allOptional: false }) : {} });
    } else if (kind === "string") {
      const s: JsonSchema = { type: "string" };
      const formats = [...shape.formats];
      if (formats.length === 1 && formats[0]) s.format = formats[0];
      const max = options.maxExamples ?? 5;
      if (!s.format && shape.strings.size > 0 && shape.strings.size <= max) {
        s.examples = [...shape.strings.keys()].sort();
      }
      schemas.push(s);
    } else {
      schemas.push({ type: kind });
    }
  }
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0]!;
  // A nullable scalar stays compact; anything else becomes anyOf.
  if (schemas.length === 2 && schemas.some((s) => s.type === "null")) {
    const other = schemas.find((s) => s.type !== "null")!;
    if (typeof other.type === "string" && other.type !== "object" && other.type !== "array") {
      return { ...other, type: [other.type, "null"] };
    }
  }
  return { anyOf: schemas };
}

export function inferSchema(samples: unknown[], options: InferOptions = {}): JsonSchema {
  const shape = emptyShape();
  for (const sample of samples) observe(shape, sample);
  return toSchema(shape, options);
}

/** Infer a scalar type from string-encoded values such as query parameters. */
export function inferScalarFromStrings(values: string[], name: string): JsonSchema {
  const opaque = /cursor|token|after|before|key|id$/i.test(name);
  if (!opaque && values.length > 0 && values.every((v) => /^-?\d+$/.test(v))) return { type: "integer" };
  if (!opaque && values.length > 0 && values.every((v) => v === "true" || v === "false")) return { type: "boolean" };
  const s: JsonSchema = { type: "string" };
  const formats = new Set(values.map(stringFormat));
  if (formats.size === 1 && [...formats][0]) s.format = [...formats][0];
  else if (values.length > 0 && !opaque) s.examples = [...new Set(values)].sort().slice(0, 5);
  return s;
}
