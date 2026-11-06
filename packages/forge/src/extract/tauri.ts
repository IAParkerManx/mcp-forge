// Tauri extractor (read-only). On macOS a Tauri app's webview has no
// debugging port, so its commands cannot be called from outside. Instead,
// forge reads `#[tauri::command]` functions from the Rust source and, for
// commands whose only effect is one read-only Docker CLI call built from
// literals, constants and parameters, reproduces that exact call. Everything
// else is listed (for the review config and report) but not made runnable.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { EvidenceRef, ForgeIR, JsonSchema, Operation } from "../ir/types.ts";
import { humanize, snake } from "../synth/heuristics.ts";

export interface RustSource {
  path: string;
  text: string;
  sha256: string;
}

export interface TauriParam {
  name: string;
  type: string;
}

export interface TauriCommand {
  name: string;
  params: TauriParam[];
  returns: string;
  body: string;
  file: string;
  line: number;
}

/** Parameters Tauri injects itself; callers never pass them. */
const INJECTED = /^(?:tauri::)?(State|AppHandle|Window|WebviewWindow|Webview|Manager|Runtime|ipc::Channel|Channel)\b|^&?(?:tauri::)?(AppHandle|Window|WebviewWindow)/;

export async function readRustSources(root: string): Promise<RustSource[]> {
  const out: RustSource[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = relative(root, full);
    if (rel.split(/[\\/]/).some((p) => p === "target" || p === "gen")) continue;
    const text = await readFile(full, "utf8");
    out.push({ path: rel, text, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Index of the brace that closes the one at `open`, skipping strings and comments. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Split on top-level commas (ignoring those inside <>, (), [], strings). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      cur += ch;
      if (ch === "\\") cur += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if ("<([{".includes(ch)) depth++;
    if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const COMMAND_FN = /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
const ANY_FN = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;

export function parseCommands(sources: RustSource[]): TauriCommand[] {
  return parseFns(sources, COMMAND_FN);
}

/** Every function in the crate, for following one level of delegation. */
export function parseAllFns(sources: RustSource[]): Map<string, TauriCommand> {
  const out = new Map<string, TauriCommand>();
  for (const f of parseFns(sources, ANY_FN, true)) if (!out.has(f.name)) out.set(f.name, f);
  return out;
}

function parseFns(sources: RustSource[], pattern: RegExp, keepInjected = false): TauriCommand[] {
  const commands: TauriCommand[] = [];
  for (const src of sources) {
    for (const m of src.text.matchAll(pattern)) {
      const name = m[1]!;
      const paramsStart = m.index! + m[0].length;
      // Find the closing parenthesis of the parameter list.
      let depth = 1;
      let i = paramsStart;
      for (; i < src.text.length && depth > 0; i++) {
        if (src.text[i] === "(") depth++;
        else if (src.text[i] === ")") depth--;
      }
      const paramText = src.text.slice(paramsStart, i - 1);
      const open = src.text.indexOf("{", i);
      const close = matchBrace(src.text, open);
      if (open < 0 || close < 0) continue;
      const returns = /->\s*([^{]+)/.exec(src.text.slice(i, open))?.[1]?.trim() ?? "()";
      const params = splitTopLevel(paramText)
        .map((p) => {
          const [pname, ...rest] = p.split(":");
          return { name: pname!.replace(/^mut\s+/, "").trim(), type: rest.join(":").trim() };
        })
        .filter((p) => p.name && p.name !== "self" && !p.name.startsWith("&self") && (keepInjected || (!p.name.startsWith("_") && !INJECTED.test(p.type))));
      commands.push({ name, params, returns, body: src.text.slice(open + 1, close), file: src.path, line: src.text.slice(0, m.index).split("\n").length + 1 });
    }
  }
  return commands;
}

/** Decode a Rust string literal body: \n, \t, \\, \", \xNN, \u{...}. */
export function rustString(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|n|t|r|0|\\|"|')/g, (_, e: string) => {
    if (e.startsWith("x")) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e.startsWith("u")) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'" } as Record<string, string>)[e]!;
  });
}

/** `const NAME: &str = "value";` anywhere in the crate. */
export function stringConstants(sources: RustSource[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) {
      if (!out.has(m[1]!)) out.set(m[1]!, rustString(m[2]!));
    }
  }
  return out;
}

const DOCKER_CALL = /\b(run_docker(?:_status|_timeout)?)\s*\(\s*&\s*\[([\s\S]*?)\]\s*(?:,[^)]*)?\)/g;
/** Docker subcommands that only read state. */
const READ_ONLY = new Set(["ps", "logs", "inspect", "images", "info", "version"]);
/** Anything else in the body that could have an effect makes a command non-reproducible. */
const SIDE_EFFECTS = /\b(Command::new|run_docker_pull|run_docker_load|std::fs::(?:write|remove|create|copy|rename)|fs::(?:write|remove|create|copy|rename)|File::create|\.emit\(|open::that|shell\(\)|restart|kill)\b/;

export type Reproduction =
  | { ok: true; argv: string[]; placeholders: string[] }
  | { ok: false; reason: string };

/** Try to turn a command body into one read-only docker argv with `{param}` placeholders. */
export function reproduce(cmd: TauriCommand, constants: Map<string, string>, fns?: Map<string, TauriCommand>): Reproduction {
  const calls = [...cmd.body.matchAll(DOCKER_CALL)];
  if (calls.length === 0 && fns) {
    // A command that only forwards to a helper: `helper(CONST)` / `helper(&param)`.
    const body = cmd.body.trim().replace(/;$/, "");
    const call = /^([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(body);
    const helper = call && fns.get(call[1]!);
    if (call && helper && helper.name !== cmd.name) {
      const args = splitTopLevel(call[2]!);
      const scoped = new Map(constants);
      const params: TauriParam[] = [];
      const rename = new Map<string, string>();
      for (const [i, hp] of helper.params.entries()) {
        const arg = (args[i] ?? "").replace(/^&/, "").replace(/\.as_str\(\)$|\.clone\(\)$/, "").trim();
        const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(arg);
        const constName = arg.split("::").at(-1)!;
        const key = `__ARG_${hp.name.toUpperCase()}`;
        if (literal) scoped.set(key, rustString(literal[1]!));
        else if (constants.has(constName)) scoped.set(key, constants.get(constName)!);
        else if (cmd.params.some((p) => p.name === arg)) {
          params.push({ name: hp.name, type: cmd.params.find((p) => p.name === arg)!.type });
          rename.set(hp.name, arg);
        } else return { ok: false, reason: `forwards \`${arg}\` to ${helper.name}, which cannot be resolved` };
      }
      // Substitute constant-bound helper parameters by name.
      let helperBody = helper.body;
      for (const hp of helper.params) {
        const key = `__ARG_${hp.name.toUpperCase()}`;
        if (scoped.has(key)) helperBody = helperBody.replace(new RegExp(`(?<![\\w.])${hp.name}(?![\\w])`, "g"), key);
      }
      const inner = reproduce({ ...helper, body: helperBody, params }, scoped, undefined);
      if (!inner.ok) return { ok: false, reason: `delegates to ${helper.name}, which ${inner.reason.replace(/^does not/, "does not")}` };
      return { ok: true, argv: inner.argv.map((a) => a.replace(/^\{(\w+)\}$/, (_, p: string) => `{${rename.get(p) ?? p}}`)), placeholders: inner.placeholders.map((p) => rename.get(p) ?? p) };
    }
  }
  if (calls.length === 0) return { ok: false, reason: "does not call the Docker CLI directly" };
  if (calls.length > 1) return { ok: false, reason: `makes ${calls.length} Docker calls` };
  const effect = SIDE_EFFECTS.exec(cmd.body.replace(DOCKER_CALL, ""));
  if (effect) return { ok: false, reason: `body also uses ${effect[1]}` };

  const paramNames = new Set(cmd.params.map((p) => p.name));
  // Locals holding string literals: let format_str = "{{.CPUPerc}}||...";
  const literalLocals = new Map<string, string>();
  for (const m of cmd.body.matchAll(/let\s+([a-z_][a-z0-9_]*)\s*(?::\s*&(?:'static\s+)?str\s*)?=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) literalLocals.set(m[1]!, rustString(m[2]!));
  // Locals derived directly from a parameter: let x = format!("{}", p); / p.to_string(); / &p
  const locals = new Map<string, string>();
  for (const m of cmd.body.matchAll(/let\s+([a-z_][a-z0-9_]*)\s*=\s*(?:format!\(\s*"\{\}"\s*,\s*([a-z_][a-z0-9_]*)\s*\)|&?([a-z_][a-z0-9_]*)\.to_string\(\)|&?([a-z_][a-z0-9_]*))\s*;/g)) {
    const source = m[2] ?? m[3] ?? m[4]!;
    if (paramNames.has(source)) locals.set(m[1]!, source);
  }
  const argv: string[] = [];
  const placeholders: string[] = [];
  for (const raw of splitTopLevel(calls[0]![2]!)) {
    const token = raw.replace(/^&/, "").replace(/\.as_str\(\)$/, "").trim();
    const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(token);
    if (literal) {
      argv.push(rustString(literal[1]!));
      continue;
    }
    if (literalLocals.has(token)) {
      argv.push(literalLocals.get(token)!);
      continue;
    }
    // Parameters (and locals derived from them) win over constants of the same spelling.
    const param = paramNames.has(token) ? token : locals.get(token);
    if (param) {
      argv.push(`{${param}}`);
      placeholders.push(param);
      continue;
    }
    const constName = token.split("::").at(-1)!;
    if (/^[A-Z_][A-Z0-9_]*$/.test(constName) && constants.has(constName)) {
      argv.push(constants.get(constName)!);
      continue;
    }
    return { ok: false, reason: `cannot resolve Docker argument \`${raw}\`` };
  }
  const sub = argv[0];
  if (!sub || !READ_ONLY.has(sub) && !(sub === "stats" && argv.includes("--no-stream")) && !(["image", "container", "network", "volume"].includes(sub) && ["inspect", "ls"].includes(argv[1] ?? ""))) {
    return { ok: false, reason: `\`docker ${argv.slice(0, 2).join(" ")}\` is not a read-only Docker command` };
  }
  return { ok: true, argv, placeholders };
}

function paramSchema(type: string): JsonSchema {
  const t = type.replace(/^Option<(.*)>$/, "$1").replace(/^&/, "");
  if (/^(String|str|&str|PathBuf|&Path)$/.test(t)) return { type: "string" };
  if (/^[ui](8|16|32|64|128|size)$/.test(t)) return { type: "integer", ...(t.startsWith("u") ? { minimum: 0 } : {}) };
  if (/^f(32|64)$/.test(t)) return { type: "number" };
  if (t === "bool") return { type: "boolean" };
  return {};
}

// A guess from the command's name, used only to label commands that are not reproduced.
const word = (w: string) => new RegExp(`(^|_)(${w})(_|$)`);
const DESTRUCTIVE = word("remove|delete|kill|revert|restore|clear|reset|quit|uninstall|wipe");
const WRITE = word("write|set|create|start|stop|restart|update|install|cancel|open|adjust|reload|request|backup");
const READ = word("get|list|inspect|check|detect|estimate|evaluate|is|verify|validate|preflight|derive|status|info|logs|stats|details");
const guessEffects = (name: string) => (DESTRUCTIVE.test(name) ? "destructive" : WRITE.test(name) ? "write" : READ.test(name) ? "read" : "unknown");

export interface TauriExtractOptions {
  targetName: string;
  appRoot: string;
  sources: RustSource[];
  docker?: string;
}

export function extractTauri(options: TauriExtractOptions): ForgeIR {
  const commands = parseCommands(options.sources);
  const constants = stringConstants(options.sources);
  const fns = parseAllFns(options.sources);
  const operations: Operation[] = [];
  const notes: string[] = [];
  const shaOf = new Map(options.sources.map((s) => [s.path, s.sha256]));
  const skipped: string[] = [];

  for (const cmd of commands) {
    const evidence: EvidenceRef[] = [{ evidence_id: `source:sha256:${shaOf.get(cmd.file)}`, note: `${cmd.file}:${cmd.line} #[tauri::command] fn ${cmd.name}` }];
    const r = reproduce(cmd, constants, fns);
    if (!r.ok) {
      const kind = guessEffects(cmd.name);
      skipped.push(`${cmd.name} (${kind}): ${r.reason}`);
      continue;
    }
    const properties: Record<string, JsonSchema> = {};
    for (const p of cmd.params.filter((x) => r.placeholders.includes(x.name))) {
      properties[snake(p.name)] = { ...paramSchema(p.type), description: `Parameter \`${p.name}: ${p.type}\` of the app's ${cmd.name} command.` };
    }
    const unused = cmd.params.filter((p) => !r.placeholders.includes(p.name));
    const required = cmd.params.filter((p) => r.placeholders.includes(p.name) && !p.type.startsWith("Option<")).map((p) => snake(p.name));
    const name = snake(`${options.targetName}_${cmd.name}`);
    operations.push({
      id: name,
      name,
      title: humanize(cmd.name),
      description: `${humanize(cmd.name)}, as the desktop app does it: \`docker ${r.argv.join(" ")}\`. Returns Docker's raw output; the app parses it into \`${cmd.returns}\`.`,
      binding: {
        kind: "cli",
        command: options.docker ?? "docker",
        subcommand: [],
        options: [],
        argv_template: r.argv.map((a) => a.replace(/\{([a-z_][a-z0-9_]*)\}/, (_, p: string) => `{${snake(p)}}`)),
        fixed_args: [],
        output: "text",
      },
      input: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      output: { type: "object", properties: { stdout: { type: "string" } }, required: ["stdout"] },
      auth: "none",
      effects: "read",
      idempotent: true,
      confidence: "inferred",
      sample_count: 0,
      evidence,
      unknowns: [
        "Reproduced from the Rust source, not observed through the app.",
        ...(/docker_api_get|docker_api_/.test(cmd.body) ? ["The app first tries Docker's Engine API and uses this CLI call only as its fallback, so numbers can differ slightly."] : []),
        ...(unused.length ? [`Parameters not used in the Docker call: ${unused.map((p) => p.name).join(", ")}.`] : []),
      ],
    });
  }
  notes.push(`${commands.length} #[tauri::command] function(s) found; ${operations.length} reproduced as read-only Docker calls.`);
  if (skipped.length) notes.push(`Not reproduced: ${skipped.join("; ")}.`);
  operations.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ir_version: 1,
    target: { kind: "tauri", name: options.targetName, app_path: options.appRoot, command: options.docker ?? "docker" },
    rea_version: "n/a",
    operations,
    auth: { kind: "none", credential_fields: [], evidence: [] },
    fixtures: [],
    sources: [],
    cli_help: [],
    notes,
  };
}
