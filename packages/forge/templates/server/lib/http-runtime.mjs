// HTTP runtime for generated servers: builds requests from tool arguments and
// keeps one session for the user's own account. Credentials only ever come
// from environment variables named in tools.json (or a file one of them names).
import { readFileSync } from "node:fs";

function pointerGet(value, pointer) {
  if (!pointer || pointer === "/") return value;
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((v, key) => (v == null ? undefined : v[key]), value);
}

async function readBody(res) {
  const text = await res.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, text, json };
}

export function createHttpRuntime(manifest, env, fetchImpl = globalThis.fetch) {
  const { auth, server } = manifest;
  const baseUrl = (env[server.base_url_env] || server.default_base_url || "").replace(/\/$/, "");
  if (!baseUrl) throw new Error(`Set ${server.base_url_env} to the target's base URL.`);
  let cookie = (auth.cookie_env && env[auth.cookie_env]) || "";
  let csrf = "";
  let token;

  /** The API token: from its variable, or read once from the file another variable names. */
  function apiToken() {
    if (token) return token;
    if (auth.token_env && env[auth.token_env]) token = env[auth.token_env].trim();
    else if (auth.token_file_env && env[auth.token_file_env]) {
      try {
        token = readFileSync(env[auth.token_file_env], "utf8").trim();
      } catch (error) {
        throw new Error(`Could not read the token file named by ${auth.token_file_env}: ${error.message}`);
      }
    }
    if (!token) throw new Error(`Set ${auth.token_env} to your API token (or ${auth.token_file_env} to a file containing it).`);
    return token;
  }

  function mergeSetCookie(res) {
    const values = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (values.length === 0) return;
    const jar = new Map(cookie.split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c]));
    for (const v of values) {
      const pair = v.split(";")[0];
      jar.set(pair.split("=")[0], pair);
    }
    cookie = [...jar.values()].join("; ");
  }

  function hasLoginCredentials() {
    const creds = auth.login_credentials_env ?? {};
    return auth.login_request && Object.keys(creds).length > 0 && Object.values(creds).every((name) => env[name]);
  }

  async function login() {
    if (!hasLoginCredentials()) {
      const names = Object.values(auth.login_credentials_env ?? {});
      throw new Error(
        `Not signed in. Set ${auth.cookie_env ?? "a session cookie"}${names.length ? ` or ${names.join(" + ")}` : ""} for your own account.`,
      );
    }
    const body = Object.fromEntries(Object.entries(auth.login_credentials_env).map(([field, name]) => [field, env[name]]));
    const res = await fetchImpl(baseUrl + auth.login_request.path, {
      method: auth.login_request.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    mergeSetCookie(res);
    const out = await readBody(res);
    if (res.status < 200 || res.status >= 300) throw new Error(`Login failed with HTTP ${res.status}.`);
    if (auth.csrf && auth.csrf.source_path === auth.login_request.path) csrf = String(pointerGet(out.json, auth.csrf.source_pointer) ?? "");
  }

  async function ensureSession() {
    if (auth.kind !== "cookie-session") return;
    if (!cookie) await login();
  }

  async function ensureCsrf() {
    if (!auth.csrf || csrf) return;
    if (auth.csrf.source_path === auth.login_request?.path) {
      await login();
      return;
    }
    const res = await send(auth.csrf.source_method, auth.csrf.source_path, undefined, false);
    csrf = String(pointerGet(res.json, auth.csrf.source_pointer) ?? "");
  }

  async function send(method, path, body, withCsrf) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    if (auth.kind === "token") headers[auth.token_header || "authorization"] = auth.token_scheme ? `${auth.token_scheme} ${apiToken()}` : apiToken();
    if (withCsrf && auth.csrf && csrf) headers[auth.csrf.header] = csrf;
    const res = await fetchImpl(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    mergeSetCookie(res);
    return readBody(res);
  }

  function buildRequest(op, args) {
    const { binding } = op;
    let path = binding.path_template;
    const query = new URLSearchParams();
    const body = {};
    for (const p of binding.params) {
      const value = args[p.name];
      if (value === undefined) continue;
      const wire = p.wire_name ?? p.name;
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
      else if (p.in === "query") query.append(wire, String(value));
      else body[wire] = value;
    }
    const qs = query.toString();
    return { path: qs ? `${path}?${qs}` : path, body: binding.json_body ? body : undefined };
  }

  return {
    async invoke(op, args) {
      const { method } = op.binding;
      const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);
      if (op.auth === "session") await ensureSession();
      if (isWrite) await ensureCsrf();
      const { path, body } = buildRequest(op, args);
      let res = await send(method, path, body, isWrite);
      // One re-login on an expired session, then give up.
      if ((res.status === 401 || res.status === 403) && op.auth === "session" && hasLoginCredentials()) {
        cookie = "";
        csrf = "";
        await login();
        if (isWrite) await ensureCsrf();
        res = await send(method, path, body, isWrite);
      }
      return res;
    },
  };
}
