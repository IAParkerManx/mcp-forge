// `mcp-forge record`: capture a HAR by calling an HTTP API directly, for APIs that
// have no browser UI to export a HAR from. Only the requests listed are sent;
// anything but GET needs an explicit opt-in because it may change data.
import { readFile, writeFile } from "node:fs/promises";

export interface RecordRequest {
  method: string;
  path: string;
  body?: unknown;
}

/** Parse `GET /models`, `/health` (GET implied) or `POST /run {"a":1}`. */
export function parseRequest(text: string): RecordRequest {
  const m = /^\s*(?:(GET|POST|PUT|PATCH|DELETE|HEAD)\s+)?(\/\S*)\s*([\s\S]*)$/i.exec(text);
  if (!m) throw new Error(`expected "[METHOD] /path [json body]", got: ${text}`);
  const body = m[3]!.trim();
  let parsed: unknown;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`request body must be JSON: ${body}`);
    }
  }
  return { method: (m[1] ?? "GET").toUpperCase(), path: m[2]!, ...(body ? { body: parsed } : {}) };
}

export interface RecordOptions {
  baseUrl: string;
  requests: RecordRequest[];
  out: string;
  allowWrites?: boolean;
  headers?: Record<string, string>;
  /** Sent with every request but written to the HAR redacted (keeping only an auth scheme word). */
  secretHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface TokenSource {
  /** Environment variable holding the token. */
  env?: string;
  /** File containing the token. */
  file?: string;
  header?: string;
  /** "Bearer" by default; "" for raw API-key headers. */
  scheme?: string;
}

/** Read a token from the variable or file the user named, and build its header. Never logged. */
export async function tokenHeader(source: TokenSource): Promise<Record<string, string>> {
  let token: string | undefined;
  if (source.env) token = process.env[source.env]?.trim();
  else if (source.file) token = (await readFile(source.file, "utf8")).trim();
  if (!token) throw new Error(source.env ? `${source.env} is not set in this shell` : `the token file ${source.file} is empty`);
  const scheme = source.scheme ?? "Bearer";
  return { [(source.header ?? "authorization").toLowerCase()]: scheme ? `${scheme} ${token}` : token };
}

function redactedHeader(name: string, value: string): string {
  const scheme = name.toLowerCase() === "authorization" ? /^([A-Za-z][\w-]*)\s/.exec(value)?.[1] : undefined;
  return scheme ? `${scheme} [REDACTED]` : "[REDACTED]";
}

export async function recordHar(options: RecordOptions): Promise<{ entries: number; statuses: number[] }> {
  const base = new URL(options.baseUrl);
  const writes = options.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");
  if (writes.length && !options.allowWrites) {
    throw new Error(`refusing to send ${writes.map((w) => `${w.method} ${w.path}`).join(", ")} without --allow-writes (they may change data)`);
  }
  const entries = [];
  for (const r of options.requests) {
    const url = new URL(r.path, base);
    if (url.origin !== base.origin) throw new Error(`${r.path} leaves ${base.origin}`);
    const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) };
    if (r.body !== undefined) headers["content-type"] = "application/json";
    const secret = options.secretHeaders ?? {};
    const started = new Date();
    const res = await fetch(url, {
      method: r.method,
      headers: { ...headers, ...secret },
      ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    const elapsed = Date.now() - started.getTime();
    entries.push({
      startedDateTime: started.toISOString(),
      time: elapsed,
      request: {
        method: r.method,
        url: url.href,
        httpVersion: "HTTP/1.1",
        headers: [...Object.entries(headers), ...Object.entries(secret).map(([name, value]) => [name, redactedHeader(name, value)] as const)].map(([name, value]) => ({ name, value })),
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: r.body === undefined ? 0 : JSON.stringify(r.body).length,
        ...(r.body !== undefined ? { postData: { mimeType: "application/json", text: JSON.stringify(r.body) } } : {}),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        httpVersion: "HTTP/1.1",
        headers: [...res.headers].map(([name, value]) => ({ name, value })),
        cookies: [],
        content: { size: text.length, mimeType: res.headers.get("content-type") ?? "", text },
        redirectURL: "",
        headersSize: -1,
        bodySize: text.length,
      },
      cache: {},
      timings: { send: 0, wait: elapsed, receive: 0 },
    });
  }
  const har = { log: { version: "1.2", creator: { name: "mcp-forge record", version: "0.1.0" }, pages: [], entries } };
  await writeFile(options.out, JSON.stringify(har, null, 2));
  return { entries: entries.length, statuses: entries.map((e) => e.response.status) };
}
