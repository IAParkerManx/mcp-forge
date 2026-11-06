// Deterministic naming, effect classification and pagination detection.
import type { Effects, JsonSchema, Pagination } from "../ir/types.ts";

const NOISE_SEGMENTS = /^(api|rest|graphql|v\d+(\.\d+)?|public|internal)$/i;
const SEARCH_WORDS = /^(search|query|find|lookup|filter)$/i;

export function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ches|shes|xes|ses)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function isPlaceholder(segment: string): boolean {
  return /^\{.+\}$/.test(segment);
}

/** Meaningful (non-placeholder, non-noise) segments of a path template. */
export function resourceSegments(pathTemplate: string): string[] {
  return pathTemplate
    .split("/")
    .filter(Boolean)
    .filter((s) => !NOISE_SEGMENTS.test(s));
}

/**
 * Name an HTTP operation from its method and path template, e.g.
 * GET /api/notes → list_notes, GET /api/notes/{id} → get_note,
 * POST /api/notes/{id}/archive → archive_note.
 */
const VERB_FIRST = /^(list|get|describe|search|find|query|generate|run|start|stop|cancel|create|delete|remove|update|set|predict|classify|export|import|upload|download|sync|check|validate|compute|count)(_|$)/;

export function nameHttpOperation(method: string, pathTemplate: string, responseIsCollection: boolean): string {
  const segments = resourceSegments(pathTemplate);
  const words = segments.filter((s) => !isPlaceholder(s)).map(snake);
  const endsWithParam = segments.length > 0 && isPlaceholder(segments.at(-1)!);
  const last = words.at(-1) ?? "root";
  const parent = words.length > 1 ? words.at(-2)! : undefined;
  const m = method.toUpperCase();

  // RPC-style paths already name the action: /list-detectors, /run-analysis, /stop.
  if (!endsWithParam && VERB_FIRST.test(last)) return parent && !VERB_FIRST.test(parent) ? `${last}_${parent}` : last;

  if (SEARCH_WORDS.test(last)) return parent ? `${last}_${parent}` : last;

  // A trailing verb-like segment after an id (POST /notes/{id}/archive).
  if (!endsWithParam && parent && segments.length >= 2 && isPlaceholder(segments.at(-2)!) && m !== "GET") {
    return `${last}_${singular(parent)}`;
  }

  switch (m) {
    case "GET":
      if (endsWithParam) return `get_${singular(last)}`;
      return responseIsCollection ? `list_${last}` : `get_${last}`;
    case "POST":
      return endsWithParam ? `post_${singular(last)}` : `create_${singular(last)}`;
    case "PUT":
      return `replace_${singular(last)}`;
    case "PATCH":
      return `update_${singular(last)}`;
    case "DELETE":
      return `delete_${singular(last)}`;
    default:
      return `${m.toLowerCase()}_${last}`;
  }
}

export function classifyHttpEffects(method: string, pathTemplate: string): { effects: Effects; idempotent: boolean } {
  const m = method.toUpperCase();
  const last = resourceSegments(pathTemplate).filter((s) => !isPlaceholder(s)).at(-1) ?? "";
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return { effects: "read", idempotent: true };
  if (m === "DELETE") return { effects: "destructive", idempotent: true };
  if (m === "PUT") return { effects: "write", idempotent: true };
  if (m === "PATCH") return { effects: "write", idempotent: false };
  if (m === "POST" && SEARCH_WORDS.test(last)) return { effects: "read", idempotent: true };
  if (m === "POST") return { effects: "write", idempotent: false };
  return { effects: "unknown", idempotent: false };
}

const CURSOR_PARAMS = /^(cursor|page_?token|after|next|continuation|starting_after|marker)$/i;
const OFFSET_PARAMS = /^(offset|skip|start)$/i;
const PAGE_PARAMS = /^(page|page_?number|p)$/i;
const NEXT_FIELDS = /^(next_?cursor|next|next_?page_?token|cursor|continuation|end_?cursor|after)$/i;

/** Find a request param that is fed by a field of the response. */
export function detectPagination(queryParams: string[], outputSchema: JsonSchema | undefined): Pagination | undefined {
  const props = (outputSchema?.properties ?? {}) as Record<string, JsonSchema>;
  const nextField = Object.keys(props).find((k) => NEXT_FIELDS.test(k));
  for (const param of queryParams) {
    if (CURSOR_PARAMS.test(param) && nextField) return { style: "cursor", request_param: param, response_field: nextField };
    if (OFFSET_PARAMS.test(param)) return { style: "offset", request_param: param, response_field: nextField ?? "" };
    if (PAGE_PARAMS.test(param)) return { style: "page", request_param: param, response_field: nextField ?? "" };
  }
  return undefined;
}

export function humanize(name: string): string {
  const text = name.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
