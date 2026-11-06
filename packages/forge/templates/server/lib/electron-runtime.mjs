// Electron runtime for generated servers: calls functions the app exposes to
// its renderer (contextBridge) through the Chrome DevTools Protocol on a
// loopback port. Either attaches to an app the user started with
// --remote-debugging-port, or launches it with a private port. Arguments are
// passed as JSON data; no caller-supplied code is ever evaluated.
import { spawn } from "node:child_process";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CALL_TIMEOUT_MS = 60_000;

function loopbackUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) throw new Error(`CDP endpoint must be http on loopback, got ${raw}`);
  return url.origin;
}

/** The JavaScript evaluated in the page: look up window[api][member] and call it with JSON arguments. */
export function callExpression(binding, args) {
  const values = binding.params.map((p) => args[p]);
  if (binding.rest && Array.isArray(args[binding.rest])) values.push(...args[binding.rest]);
  while (values.length && values.at(-1) === undefined) values.pop();
  const api = JSON.stringify(binding.api);
  const member = JSON.stringify(binding.member);
  // JSON.stringify of plain data is a valid JavaScript expression; undefined holes become null.
  return `(async () => {
  const api = globalThis[${api}];
  if (!api || typeof api[${member}] !== "function") throw new Error("window." + ${api} + "." + ${member} + " is not available in this page");
  return await api[${member}](...${JSON.stringify(values)});
})()`;
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id !== undefined && this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter(msg);
      }
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter({ error: { message: "CDP connection closed" } });
      this.pending.clear();
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

/** Launch an Electron app with a private loopback debugging port and wait for it. */
function launch(executable, appArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...appArgs, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`app did not open a debugging port within 30s: ${stderr.slice(-500)}`));
    }, 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve({ child, origin: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not launch ${executable}: ${e.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app exited (${code}) before opening a debugging port: ${stderr.slice(-500)}`));
    });
  });
}

export function createElectronRuntime(manifest, env) {
  const { server } = manifest;
  const cdpUrl = server.cdp_url_env && env[server.cdp_url_env];
  const executable = (server.electron_env && env[server.electron_env]) || server.default_electron;
  const appPath = (server.app_env && env[server.app_env]) ?? server.default_app;
  let state;

  async function connect() {
    let origin;
    let child;
    if (cdpUrl) origin = loopbackUrl(cdpUrl);
    else if (executable) ({ child, origin } = await launch(executable, appPath ? [appPath] : [], env));
    else throw new Error(`Set ${server.cdp_url_env} to a running app's debugging endpoint, or ${server.electron_env} to launch it.`);
    if (child) {
      const stop = () => child.kill();
      process.once("exit", stop);
      child.once("exit", () => {
        state = undefined;
      });
    }
    return { origin, child, sessions: new Map() };
  }

  async function pageSession(hint) {
    state ??= await connect();
    // The window may still be loading right after launch.
    for (let attempt = 0; attempt < 50; attempt++) {
      const targets = await (await fetch(`${state.origin}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && (!hint || t.url.includes(hint))) ?? (hint ? undefined : targets.find((t) => t.type === "page"));
      if (page) {
        let session = state.sessions.get(page.id);
        if (!session) {
          session = await CdpSession.open(page.webSocketDebuggerUrl);
          state.sessions.set(page.id, session);
        }
        return session;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no renderer page${hint ? ` matching "${hint}"` : ""} found`);
  }

  return {
    async invoke(op, args) {
      const { binding } = op;
      const session = await pageSession(binding.page_url_hint);
      for (let attempt = 0; ; attempt++) {
        const result = await session.send("Runtime.evaluate", { expression: callExpression(binding, args), awaitPromise: true, returnByValue: true });
        if (!result.exceptionDetails) return { ok: true, value: result.result.value };
        const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        // Right after launch the preload may not have run yet.
        if (attempt < 20 && /is not available in this page/.test(message)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        return { ok: false, error: message.split("\n")[0] };
      }
    },
    close() {
      if (!state) return;
      for (const s of state.sessions.values()) s.close();
      state.child?.kill();
      state = undefined;
    },
  };
}
