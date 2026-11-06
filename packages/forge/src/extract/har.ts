// Web extractor: REA `inspect_web_network_capture` Evidence (HAR records) → IR.
// REA decodes the capture and strips transport credentials; forge groups the
// records into operations, infers schemas and models the session.
import type { AuthModel, EvidenceRef, Fixture, ForgeIR, HttpParam, JsonSchema, Operation } from "../ir/types.ts";
import type { ReaEvidence } from "../rea/client.ts";
import { inferScalarFromStrings, inferSchema } from "../synth/schema.ts";
import { classifyHttpEffects, detectPagination, humanize, nameHttpOperation, singular, snake } from "../synth/heuristics.ts";
import { collectSecrets, isSecretKey, redact } from "../synth/redact.ts";

interface HarHeader {
  name: string;
  value: string | null;
}

interface HarRecord {
  ordinal: number;
  reported: {
    request: { method: string; url: string; headers?: HarHeader[]; postData?: { mimeType?: string; text?: string | null } };
    response: { status: number; headers?: HarHeader[]; content?: { mimeType?: string; text?: string | null } };
  };
}

export interface Observation {
  ordinal: number;
  method: string;
  origin: string;
  segments: string[];
  query: [string, string][];
  requestHeaders: HarHeader[];
  requestBody: unknown;
  status: number;
  responseType: string;
  responseBody: unknown;
  hadCookie: boolean;
  /** Token header seen on this request, with its scheme when the value showed one. */
  token?: { header: string; scheme?: string };
}

const STATIC_TYPES = /^(text\/(html|css|javascript)|application\/javascript|image\/|font\/)/i;
/** Headers that carry an API token. Their values are never used, only their presence and scheme. */
export const TOKEN_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-auth-token", "x-access-token", "apikey"]);
const STANDARD_HEADERS = new Set([...TOKEN_HEADERS, "accept", "accept-encoding", "accept-language", "content-type", "content-length", "cookie", "user-agent", "origin", "referer", "host", "connection", "cache-control", "pragma"]);

function parseJson(text: string | null | undefined): unknown {
  if (text == null || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tokenOf(headers: HarHeader[]): { token?: { header: string; scheme?: string } } {
  const h = headers.find((x) => TOKEN_HEADERS.has(x.name.toLowerCase()));
  if (!h) return {};
  // Only the scheme word is kept ("Bearer"); the credential itself is never read.
  const scheme = h.name.toLowerCase() === "authorization" && typeof h.value === "string" ? /^([A-Za-z][\w-]*)\s/.exec(h.value)?.[1] : undefined;
  return { token: { header: h.name.toLowerCase(), ...(scheme ? { scheme } : {}) } };
}

export function toObservations(evidence: ReaEvidence): Observation[] {
  const records = (evidence.normalized_result.records ?? []) as HarRecord[];
  const out: Observation[] = [];
  for (const r of records) {
    const { request, response } = r.reported;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }
    const responseType = (response.content?.mimeType ?? "").split(";")[0]!.trim();
    out.push({
      ordinal: r.ordinal,
      method: request.method.toUpperCase(),
      origin: url.origin,
      segments: url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
      query: [...url.searchParams],
      requestHeaders: request.headers ?? [],
      requestBody: parseJson(request.postData?.text),
      status: response.status,
      responseType,
      responseBody: parseJson(response.content?.text),
      hadCookie: (request.headers ?? []).some((h) => h.name.toLowerCase() === "cookie"),
      ...tokenOf(request.headers ?? []),
    });
  }
  return out;
}

const SEGMENT_RULES: [RegExp, string][] = [
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "uuid"],
  [/^\d+$/, "numeric"],
  [/^[0-9a-f]{16,}$/i, "hex"],
  [/^\d{4}-\d{2}-\d{2}/, "date"],
];

/** Replace identifier-like segments with named placeholders. */
export function templatePath(segments: string[]): { template: string; params: { name: string; index: number; rule: string }[] } {
  const params: { name: string; index: number; rule: string }[] = [];
  const out = segments.map((seg, index) => {
    const rule = SEGMENT_RULES.find(([re]) => re.test(seg))?.[1];
    if (!rule) return seg;
    const prev = index > 0 ? segments[index - 1]! : "";
    let name = rule === "date" ? "date" : prev && !SEGMENT_RULES.some(([re]) => re.test(prev)) ? `${singular(snake(prev))}_id` : "id";
    while (params.some((p) => p.name === name)) name = `${name}_${params.length + 1}`;
    params.push({ name, index, rule });
    return `{${name}}`;
  });
  return { template: "/" + out.join("/"), params };
}

function isApiCall(o: Observation): boolean {
  if (o.method !== "GET") return true;
  if (STATIC_TYPES.test(o.responseType)) return false;
  return /json/i.test(o.responseType) || o.responseBody !== undefined;
}

/** A list response: an array, or an object holding the list under a generic or resource-named key. */
function isCollection(body: unknown, resource?: string): boolean {
  if (Array.isArray(body)) return true;
  if (body && typeof body === "object") {
    return Object.entries(body).some(([k, v]) => Array.isArray(v) && (/^(items|data|results|entries|records|nodes|edges)$/i.test(k) || (resource !== undefined && snake(k) === snake(resource))));
  }
  return false;
}

function looksLikeLogin(o: Observation): boolean {
  if (o.method !== "POST" || !o.requestBody || typeof o.requestBody !== "object") return false;
  return Object.keys(o.requestBody).some((k) => /^pass(word|wd)?$/i.test(k));
}

/** Find a JSON pointer in `body` whose string value equals `value`. */
export function findPointer(body: unknown, value: string, path = ""): string | undefined {
  if (typeof body === "string") return body === value ? path || "/" : undefined;
  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const hit = findPointer(body[i], value, `${path}/${i}`);
      if (hit) return hit;
    }
  } else if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      const hit = findPointer(v, value, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

export interface ExtractOptions {
  targetName: string;
  reaVersion: string;
}

/** Secret literals in a capture: secret-keyed body values and custom-header tokens. */
export function captureSecrets(observations: Observation[]): Set<string> {
  const secrets = new Set<string>();
  for (const o of observations) {
    collectSecrets(o.requestBody, secrets);
    collectSecrets(o.responseBody, secrets);
    for (const h of o.requestHeaders) if (h.value && (isSecretKey(h.name) || !STANDARD_HEADERS.has(h.name.toLowerCase()))) secrets.add(h.value);
  }
  return secrets;
}

export function extractWeb(evidence: ReaEvidence, options: ExtractOptions): ForgeIR {
  const all = toObservations(evidence);
  const api = all.filter(isApiCall);
  const notes: string[] = [];
  const skipped = all.length - api.length;
  if (skipped > 0) notes.push(`${skipped} record(s) skipped as static assets or non-API responses.`);

  const ref = (records: number[], note?: string): EvidenceRef => ({ evidence_id: evidence.evidence_id, records, ...(note ? { note } : {}) });

  // Group by method + origin + path template.
  const groups = new Map<string, { method: string; origin: string; template: string; params: { name: string; index: number }[]; obs: Observation[] }>();
  for (const o of api) {
    const { template, params } = templatePath(o.segments);
    const key = `${o.method} ${o.origin}${template}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { method: o.method, origin: o.origin, template, params, obs: [] }));
    g.obs.push(o);
  }

  // Session model.
  const auth: AuthModel = { kind: "none", credential_fields: [], evidence: [] };
  const loginObs = api.find(looksLikeLogin);
  let loginOpId: string | undefined;
  if (api.some((o) => o.hadCookie)) {
    auth.kind = "cookie-session";
    auth.evidence.push(ref(api.filter((o) => o.hadCookie).map((o) => o.ordinal), "requests carried a Cookie header (value withheld by REA)"));
  }
  const tokenObs = api.filter((o) => o.token);
  if (tokenObs.length) {
    const first = tokenObs[0]!.token!;
    const scheme = tokenObs.find((o) => o.token!.scheme)?.token!.scheme;
    auth.kind = "token";
    auth.token = {
      header: first.header,
      scheme: first.header === "authorization" ? (scheme ?? "Bearer") : "",
      scheme_observed: first.header !== "authorization" || Boolean(scheme),
    };
    auth.evidence.push(ref(tokenObs.map((o) => o.ordinal), `requests carried a ${first.header} header (value withheld)`));
    if (first.header === "authorization" && !scheme) notes.push("The Authorization scheme was not visible in the capture; Bearer is assumed. Change auth.token_scheme in forge.config.yaml if needed.");
  }
  if (loginObs) {
    const { template } = templatePath(loginObs.segments);
    loginOpId = snake(`${loginObs.method}_${template}`);
    auth.login_operation = loginOpId;
    auth.login_request = { method: loginObs.method, path: template };
    auth.credential_fields = Object.entries(loginObs.requestBody as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([k]) => k);
    auth.evidence.push(ref([loginObs.ordinal], "login request with a password field"));
  }

  // CSRF: a custom request header whose value was returned by an earlier
  // response. A GET source is preferred so a pasted session cookie can still
  // fetch the token without replaying the login.
  for (const o of api) {
    for (const h of o.requestHeaders) {
      const name = h.name.toLowerCase();
      if (STANDARD_HEADERS.has(name) || !h.value || auth.csrf) continue;
      const sources = api
        .filter((p) => p.ordinal !== o.ordinal)
        .map((p) => ({ p, pointer: findPointer(p.responseBody, h.value!) }))
        .filter((c): c is { p: Observation; pointer: string } => c.pointer !== undefined);
      const best = sources.find((c) => c.p.method === "GET") ?? sources[0];
      if (best) {
        const { template } = templatePath(best.p.segments);
        auth.csrf = {
          header: name,
          source_operation: snake(`${best.p.method}_${template}`),
          source_method: best.p.method,
          source_path: template,
          source_pointer: best.pointer,
        };
        auth.evidence.push(ref([best.p.ordinal, o.ordinal], `header ${name} echoes ${best.pointer} from ${best.p.method} ${template}`));
      }
    }
  }

  // Values that must never reach fixtures.
  const secrets = captureSecrets(api);

  const operations: Operation[] = [];
  const fixtures: Fixture[] = [];
  const usedNames = new Set<string>();

  for (const g of groups.values()) {
    const id = snake(`${g.method}_${g.template}`);
    const ordinals = g.obs.map((o) => o.ordinal);
    if (id === loginOpId) {
      notes.push(`${g.method} ${g.template} is the login request; it is modeled as auth, not a tool.`);
      continue;
    }
    const ok = g.obs.filter((o) => o.status >= 200 && o.status < 300);
    const unknowns: string[] = [];
    if (ok.length === 0) unknowns.push("No successful response was observed.");
    if (g.obs.length < 3) unknowns.push(`Only ${g.obs.length} sample(s); optional fields and enums are likely incomplete.`);

    // Input schema: path params, then query params, then body fields.
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const params: HttpParam[] = [];
    for (const p of g.params) {
      const values = g.obs.map((o) => o.segments[p.index]!);
      properties[p.name] = { ...inferScalarFromStrings(values, p.name), description: `Path parameter (${g.template}).` };
      delete properties[p.name]!.examples;
      required.push(p.name);
      params.push({ name: p.name, in: "path" });
    }
    const queryNames = [...new Set(g.obs.flatMap((o) => o.query.map(([k]) => k)))].sort();
    for (const q of queryNames) {
      const values = g.obs.flatMap((o) => o.query.filter(([k]) => k === q).map(([, v]) => v));
      const argName = properties[q] ? `query_${q}` : q;
      properties[argName] = { ...inferScalarFromStrings(values, q), description: `Query parameter \`${q}\`.` };
      params.push({ name: argName, in: "query", ...(argName !== q ? { wire_name: q } : {}) });
    }
    const bodies = g.obs.map((o) => o.requestBody).filter((b) => b !== undefined);
    let jsonBody = false;
    if (bodies.length > 0) {
      const bodySchema = inferSchema(bodies, { allOptional: g.method === "PATCH" });
      if (bodySchema.type === "object") {
        jsonBody = true;
        for (const [k, s] of Object.entries((bodySchema.properties ?? {}) as Record<string, JsonSchema>)) {
          const argName = properties[k] ? `body_${k}` : k;
          properties[argName] = { ...s, description: `Request body field \`${k}\`.` };
          params.push({ name: argName, in: "body", ...(argName !== k ? { wire_name: k } : {}) });
          if (((bodySchema.required ?? []) as string[]).includes(k)) required.push(argName);
        }
      } else {
        unknowns.push("Request body is not a JSON object; body arguments were not modeled.");
      }
    }
    const input: JsonSchema = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };

    // Output schema from successful JSON responses.
    const responses = ok.map((o) => o.responseBody).filter((b) => b !== undefined);
    let output: JsonSchema | undefined;
    let wrapped: string | undefined;
    if (responses.length > 0) {
      const schema = inferSchema(responses);
      if (schema.type === "object") output = schema;
      else {
        wrapped = Array.isArray(responses[0]) ? "items" : "value";
        output = { type: "object", properties: { [wrapped]: schema }, required: [wrapped] };
      }
    }

    const { effects, idempotent } = classifyHttpEffects(g.method, g.template);
    const resource = g.template.split("/").filter((x) => x && !x.startsWith("{")).at(-1);
    let name = nameHttpOperation(g.method, g.template, responses.some((r) => isCollection(r, resource)));
    while (usedNames.has(name)) name = `${name}_${usedNames.size}`;
    usedNames.add(name);
    const pagination = detectPagination(queryNames, output);
    const requiresSession = g.obs.some((o) => o.hadCookie || o.token);

    operations.push({
      id,
      name,
      title: humanize(name),
      description: `${humanize(name)} (${g.method} ${g.template}).`,
      binding: {
        kind: "http",
        method: g.method,
        origin: g.origin,
        path_template: g.template,
        params,
        json_body: jsonBody,
        success_statuses: [...new Set(ok.map((o) => o.status))].sort(),
        ...(ok[0]?.responseType ? { response_content_type: ok[0].responseType } : {}),
      },
      input,
      ...(output ? { output } : {}),
      ...(wrapped ? { output_wrapped_as: wrapped } : {}),
      auth: requiresSession ? "session" : "none",
      effects,
      idempotent,
      ...(pagination ? { pagination } : {}),
      confidence: "observed",
      sample_count: g.obs.length,
      evidence: [ref(ordinals)],
      unknowns,
    });

    for (const o of g.obs) {
      const args: Record<string, unknown> = {};
      for (const p of g.params) args[p.name] = o.segments[p.index];
      for (const [k, v] of o.query) {
        const param = params.find((p) => p.in === "query" && (p.wire_name ?? p.name) === k)!;
        const type = (properties[param.name] as JsonSchema).type;
        args[param.name] = type === "integer" ? Number(v) : type === "boolean" ? v === "true" : v;
      }
      if (o.requestBody && typeof o.requestBody === "object" && !Array.isArray(o.requestBody)) {
        for (const [k, v] of Object.entries(o.requestBody)) {
          const param = params.find((p) => p.in === "body" && (p.wire_name ?? p.name) === k);
          if (param) args[param.name] = v;
        }
      }
      // Where did each identifier-like argument come from? The most recent
      // earlier response that contained it.
      const derived: Fixture["derived"] = [];
      for (const [arg, value] of Object.entries(args)) {
        if (typeof value !== "string" || value.length < 6 || secrets.has(value)) continue;
        for (const prev of [...api].reverse()) {
          if (prev.ordinal >= o.ordinal) continue;
          const pointer = findPointer(prev.responseBody, value);
          if (pointer) {
            derived.push({ argument: arg, from_ordinal: prev.ordinal, pointer });
            break;
          }
        }
      }
      fixtures.push({
        operation_id: id,
        ordinal: o.ordinal,
        arguments: redact(args, secrets),
        derived,
        status: o.status,
        ...(o.responseBody !== undefined ? { response: redact(o.responseBody, secrets) } : {}),
        evidence: ref([o.ordinal]),
      });
    }
  }

  operations.sort((a, b) => a.name.localeCompare(b.name));
  fixtures.sort((a, b) => a.ordinal - b.ordinal);
  const origins = [...new Set(api.map((o) => o.origin))];
  if (origins.length > 1) notes.push(`Multiple origins observed: ${origins.join(", ")}. base_url uses the most frequent.`);
  const base = origins.sort((a, b) => api.filter((o) => o.origin === b).length - api.filter((o) => o.origin === a).length)[0];

  return {
    ir_version: 1,
    target: { kind: "web", name: options.targetName, ...(base ? { base_url: base } : {}) },
    rea_version: options.reaVersion,
    operations,
    auth,
    fixtures,
    sources: [],
    cli_help: [],
    notes,
  };
}
