// adb runtime for generated servers: drives an app's exported content
// providers (`content query/insert/update/delete`) and activities (`am start`)
// on one device. adb runs without a host shell, and every argument is
// single-quoted for the device shell, so values cannot become commands.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

/** Quote one argument for the device's /system/bin/sh. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function fillTemplate(template, args) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = args[name];
    if (value === undefined || value === null || value === "") throw new Error(`Missing argument "${name}".`);
    if (name.endsWith("_id") && !/^\d+$/.test(String(value))) throw new Error(`Argument "${name}" must be a non-negative integer.`);
    return encodeURIComponent(String(value));
  });
}

function bindValue(type, value) {
  if (type === "b") return value ? "true" : "false";
  if ((type === "i" || type === "l") && !Number.isInteger(Number(value))) throw new Error(`Expected an integer, got ${JSON.stringify(value)}.`);
  if ((type === "f" || type === "d") && !Number.isFinite(Number(value))) throw new Error(`Expected a number, got ${JSON.stringify(value)}.`);
  return String(value);
}

/** The device-side command (as an argument list) for one operation. */
export function deviceCommand(binding, args) {
  if (binding.op === "activity") {
    const cmd = ["am", "start", "-W", "-n", binding.component];
    if (binding.intent_action) cmd.push("-a", binding.intent_action);
    if (binding.data_uri_template) cmd.push("-d", fillTemplate(binding.data_uri_template, args));
    const flags = { s: "--es", i: "--ei", l: "--el", f: "--ef", z: "--ez" };
    for (const e of binding.extras) {
      const value = args[e.name];
      if (value === undefined || value === null) continue;
      cmd.push(flags[e.type], e.key, e.type === "z" ? (value ? "true" : "false") : bindValue(e.type === "s" ? "s" : e.type === "f" ? "f" : "i", value));
    }
    return cmd;
  }
  const verb = binding.op.slice("provider-".length);
  const cmd = ["content", verb, "--uri", fillTemplate(binding.uri_template, args)];
  if (verb === "query" && Array.isArray(args.columns) && args.columns.length) {
    const known = new Set(binding.columns.map((c) => c.name));
    for (const c of args.columns) if (!known.has(c)) throw new Error(`Unknown column ${JSON.stringify(c)}.`);
    cmd.push("--projection", args.columns.join(":"));
  }
  if (verb === "insert" || verb === "update") {
    const binds = binding.binds.filter((b) => args[b.name] !== undefined && args[b.name] !== null);
    if (!binds.length) throw new Error("Give at least one field to write.");
    for (const b of binds) cmd.push("--bind", `${b.column}:${b.type}:${bindValue(b.type, args[b.name])}`);
  }
  return cmd;
}

/** Parse `Row: 0 _id=1, title=Buy milk, body=` lines using the known column names. */
export function parseRows(text, columns) {
  const names = columns.map((c) => c.name);
  const types = Object.fromEntries(columns.map((c) => [c.name, c.type]));
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^Row: \d+ (.*)$/.exec(line);
    if (!m) continue;
    const body = m[1];
    // Split at ", <known column>=" (or any identifier when columns are unknown).
    const pattern = names.length ? new RegExp(`(?:^|, )(${names.map((n) => n.replace(/[^\w]/g, "")).join("|")})=`, "g") : /(?:^|, )([A-Za-z_]\w*)=/g;
    const marks = [...body.matchAll(pattern)];
    const row = {};
    marks.forEach((mark, i) => {
      const start = mark.index + mark[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
      const raw = body.slice(start, end);
      const type = types[mark[1]];
      row[mark[1]] = raw === "NULL" ? null : type === "integer" && /^-?\d+$/.test(raw) ? Number(raw) : type === "number" && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    });
    rows.push(row);
  }
  return rows;
}

function failure(text) {
  const lines = text.split(/\r?\n/);
  const bad = lines.find((l) => /^(Error|Exception|java\.lang\.\w+(Exception|Error)|Security exception)/.test(l.trim()) || /Error while accessing provider/.test(l));
  if (!bad) return undefined;
  const detail = lines.find((l) => /Exception: /.test(l)) ?? bad;
  return detail.trim();
}

export function createAdbRuntime(manifest, env) {
  const { server } = manifest;
  const adb = (server.adb_env && env[server.adb_env]) || server.default_adb || "adb";
  const serial = server.serial_env && env[server.serial_env];

  function run(deviceArgs) {
    const argv = [...(serial ? ["-s", serial] : []), "shell", ...deviceArgs.map(shellQuote)];
    return new Promise((resolve, reject) => {
      const child = spawn(adb, argv, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
      const take = (chunk) => {
        out += chunk.toString("utf8");
        if (out.length > MAX_OUTPUT) child.kill("SIGTERM");
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run ${adb}: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  }

  return {
    async invoke(op, args) {
      const { binding } = op;
      const { code, out } = await run(deviceCommand(binding, args));
      const error = failure(out) ?? (code !== 0 ? `adb exited ${code}: ${out.trim().slice(0, 500)}` : undefined);
      if (error) return { ok: false, error };
      if (binding.op === "provider-query") {
        const rows = /No result found\./.test(out) ? [] : parseRows(out, binding.columns);
        return { ok: true, value: { rows, count: rows.length } };
      }
      if (binding.op === "activity") return { ok: true, value: { started: /Status: ok|Complete/.test(out), component: binding.component } };
      return { ok: true, value: { ok: true } };
    },
  };
}
