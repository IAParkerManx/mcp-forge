// `mcp-forge create <target>`: the whole pipeline in one command. It detects
// what the target is, records/investigates it, drafts the review config
// (read-only tools enabled), generates and installs the server, replays the
// read-only samples, and prints how to add the server to an MCP client.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ForgeIR } from "../ir/types.ts";
import { draftConfig, renderConfig } from "../curate/config.ts";
import { generateServer, type Manifest } from "../codegen/generate.ts";
import { verifyServer, type CheckResult } from "../verify/replay.ts";
import { investigateWeb } from "../investigate/web.ts";
import { investigateCli } from "../investigate/cli.ts";
import { investigateElectron } from "../investigate/electron.ts";
import { investigateTauri } from "../investigate/tauri.ts";
import { recordHar, tokenHeader, type TokenSource } from "../investigate/record.ts";
import { snake } from "../synth/heuristics.ts";

const run = promisify(execFile);

export type TargetKind = "api" | "web" | "cli" | "electron" | "tauri";

export interface DetectedTarget {
  kind: TargetKind;
  /** URL, HAR path, command, app path or src-tauri directory, depending on kind. */
  location: string;
  /** Electron: the executable that runs the app, when it could be found. */
  electron?: string;
}

function onPath(command: string): boolean {
  // Windows looks commands up with the extensions in PATHEXT (node → node.exe).
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, command + ext))));
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The Electron executable an app's own `electron` package has installed, or
 * undefined. It reads the package's files rather than requiring it: requiring
 * `electron` downloads the binary (~100 MB) when it is missing.
 */
export function installedElectron(fromDir: string): string | undefined {
  try {
    const pkg = createRequire(join(fromDir, "package.json")).resolve("electron/package.json");
    const dir = dirname(pkg);
    const pathFile = join(dir, "path.txt");
    if (!existsSync(pathFile)) return undefined;
    const exe = join(process.env.ELECTRON_OVERRIDE_DIST_PATH ?? join(dir, "dist"), readFileSync(pathFile, "utf8").trim());
    return existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

function usesElectron(dir: string): boolean {
  for (let d = dir, i = 0; i < 4; d = dirname(d), i++) {
    const pkg = readJson(join(d, "package.json"));
    const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) };
    if ("electron" in deps) return true;
  }
  return false;
}

/** Work out what kind of thing the user pointed at. */
export function detectTarget(target: string): DetectedTarget {
  if (/^https?:\/\//i.test(target)) return { kind: "api", location: target.replace(/\/$/, "") };
  const path = resolve(target);
  if (existsSync(path)) {
    const stat = statSync(path);
    if (stat.isFile() && /\.har$/i.test(path)) return { kind: "web", location: path };
    const dir = stat.isDirectory() ? path : dirname(path);
    if (stat.isDirectory() && existsSync(join(path, "src-tauri"))) return { kind: "tauri", location: join(path, "src-tauri") };
    if (stat.isDirectory() && basename(path) === "src-tauri") return { kind: "tauri", location: path };
    if (stat.isDirectory() && /^\s*tauri\s*=/m.test(existsSync(join(path, "Cargo.toml")) ? readFileSync(join(path, "Cargo.toml"), "utf8") : "")) {
      return { kind: "tauri", location: path };
    }
    if ((stat.isDirectory() || /\.(c|m)?js$/.test(path)) && usesElectron(dir)) {
      const electron = installedElectron(dir);
      return { kind: "electron", location: path, ...(electron ? { electron } : {}) };
    }
    if (stat.isFile()) return { kind: "cli", location: path };
    throw new Error(`${target} is a directory, but not a Tauri or Electron app; point at an executable, an app, a .har file or a URL`);
  }
  if (!target.includes("/") && onPath(target)) return { kind: "cli", location: target };
  throw new Error(`${target} is not a URL, a file, or a command on your PATH`);
}

interface OpenApiDoc {
  info?: { title?: string };
  paths?: Record<string, Record<string, { parameters?: { in?: string; required?: boolean }[]; requestBody?: unknown }>>;
}

/**
 * GET endpoints that need no input, read from the API's own OpenAPI document
 * (FastAPI, plumber, springdoc and others publish one). Nothing else is called.
 */
export async function discoverGets(baseUrl: string, headers: Record<string, string> = {}): Promise<{ paths: string[]; title?: string; spec?: string }> {
  for (const candidate of ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs", "/docs/openapi.json"]) {
    let doc: OpenApiDoc;
    try {
      const res = await fetch(baseUrl + candidate, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      doc = (await res.json()) as OpenApiDoc;
    } catch {
      continue;
    }
    if (!doc?.paths) continue;
    const paths = Object.entries(doc.paths)
      .filter(([path, ops]) => {
        const get = ops.get;
        if (!get || path.includes("{")) return false;
        return !(get.parameters ?? []).some((p) => p.required);
      })
      .map(([path]) => path)
      .filter((path) => !/^\/(docs|redoc|openapi|swagger|api-docs)/.test(path));
    const title = doc.info?.title && !/^(fastapi|api title|api|swagger)$/i.test(doc.info.title) ? doc.info.title : undefined;
    return { paths, ...(title ? { title } : {}), spec: candidate };
  }
  return { paths: [] };
}

export interface CreateOptions {
  target: DetectedTarget;
  name?: string;
  outDir?: string;
  /** API: paths to GET (default: discovered from OpenAPI). */
  gets?: string[];
  /** CLI: sample command lines to run. Electron/Tauri: sample calls to make. */
  runs?: string[];
  calls?: string[];
  env?: Record<string, string>;
  /** Tool names (or operation ids) to enable even though they are not read-only. */
  enable?: string[];
  /** API: an access token to send, from an environment variable or a file. */
  token?: TokenSource;
  install?: boolean;
  verify?: boolean;
  log?: (line: string) => void;
}

export interface CreateResult {
  projectDir: string;
  serverDir: string;
  ir: ForgeIR;
  manifest: Manifest;
  results?: CheckResult[];
  claudeCommand: string;
  clientConfig: Record<string, unknown>;
}

function defaultName(target: DetectedTarget, apiTitle?: string): string {
  if (target.kind === "api") {
    if (apiTitle) return snake(apiTitle).replace(/_/g, "-");
    const url = new URL(target.location);
    const host = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname) ? "local-api" : url.hostname.replace(/^www\./, "").split(".")[0]!;
    return `${host}${url.port ? `-${url.port}` : ""}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  }
  const base = basename(target.kind === "tauri" ? dirname(target.location) : target.location).replace(/\.(har|m?js|cjs|exe|py|sh)$/i, "");
  return base === "main" || base === "index" || base === "app" ? basename(dirname(resolve(target.location))) : base;
}

/** Environment a client must provide: credentials have no defaults, so they become placeholders. */
function requiredEnv(manifest: Manifest): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [field, name] of Object.entries(manifest.auth.login_credentials_env ?? {})) env[name] = `<your ${field}>`;
  if (manifest.auth.kind === "cookie-session" && !Object.keys(env).length && manifest.auth.cookie_env) env[manifest.auth.cookie_env] = "<cookie from your signed-in session>";
  return env;
}

export async function runCreate(options: CreateOptions): Promise<CreateResult> {
  const log = options.log ?? (() => {});
  const { target } = options;
  let gets = options.gets ?? [];
  let apiTitle: string | undefined;
  const auth = options.token && target.kind === "api" ? await tokenHeader(options.token) : undefined;
  if (target.kind === "api" && gets.length === 0) {
    const found = await discoverGets(target.location, auth);
    if (!found.paths.length) throw new Error(`no OpenAPI document with input-free GET endpoints found at ${target.location}; list paths with --get /path`);
    gets = found.paths;
    apiTitle = found.title;
    log(`Found ${gets.length} read-only endpoint(s) in ${target.location}${found.spec}: ${gets.join(", ")}`);
  }
  const name = options.name ?? defaultName(target, apiTitle);
  const projectDir = resolve(options.outDir ?? `${name}-mcp`);
  const serverDir = join(projectDir, "server");
  await mkdir(projectDir, { recursive: true });

  let ir: ForgeIR;
  switch (target.kind) {
    case "api": {
      const har = join(projectDir, "capture.har");
      log(`Recording ${gets.length} GET request(s) to ${target.location}…`);
      await recordHar({ baseUrl: target.location, requests: gets.map((path) => ({ method: "GET", path })), out: har, ...(auth ? { secretHeaders: auth } : {}) });
      ir = await investigateWeb({ harPath: har, projectDir, targetName: name });
      // REA hides Authorization values entirely, so use what was actually sent:
      // the same header and scheme, and the same variable for the generated server.
      if (options.token) {
        ir.auth.kind = "token";
        ir.auth.token = {
          header: (options.token.header ?? "authorization").toLowerCase(),
          scheme: options.token.scheme ?? "Bearer",
          scheme_observed: true,
          ...(options.token.env ? { env_hint: options.token.env } : {}),
        };
        ir.notes = ir.notes.filter((n) => !n.includes("Bearer is assumed"));
        for (const op of ir.operations) op.auth = "session";
      }
      break;
    }
    case "web":
      log("Investigating the HAR capture with REA…");
      ir = await investigateWeb({ harPath: target.location, projectDir, targetName: name });
      break;
    case "cli":
      log(`Capturing --help for ${target.location} and its subcommands with REA${options.runs?.length ? `, then running ${options.runs.length} sample(s)` : ""}…`);
      ir = await investigateCli({ command: target.location, projectDir, targetName: name, runs: options.runs, env: options.env });
      break;
    case "electron":
      log(`Analyzing the Electron app with REA${options.calls?.length ? `, then making ${options.calls.length} sample call(s)` : ""}…`);
      if (options.calls?.length && !target.electron) throw new Error("could not find the app's Electron executable for sample calls; pass --electron <path>");
      ir = await investigateElectron({ appPath: target.location, projectDir, targetName: name, ...(target.electron ? { electronExecutable: target.electron } : {}), calls: options.calls, env: options.env });
      break;
    case "tauri":
      log("Reading the Tauri app's Rust commands…");
      ir = await investigateTauri({ sourceDir: target.location, projectDir, targetName: name, calls: options.calls });
      break;
  }
  log(`Found ${ir.operations.length} operation(s): ${ir.operations.map((o) => `${o.name} (${o.effects})`).join(", ") || "none"}`);
  if (!ir.operations.length) throw new Error(`nothing to expose: ${ir.notes.join(" ")}`);

  const config = draftConfig(ir);
  for (const wanted of options.enable ?? []) {
    const entry = Object.entries(config.tools).find(([id, t]) => t.name === wanted || id === wanted);
    if (!entry) throw new Error(`--enable ${wanted}: no such tool (found: ${Object.values(config.tools).map((t) => t.name).join(", ")})`);
    entry[1].enabled = true;
  }
  await writeFile(join(projectDir, "forge.config.yaml"), renderConfig(config, ir));
  if (!Object.values(config.tools).some((t) => t.enabled)) {
    const found = ir.operations.map((o) => `${o.name} (${o.effects})`).join(", ");
    throw new Error(
      `no tool was enabled: everything found may change data or has unknown effects (${found}). ` +
        `If you trust them, run create again with --enable <tool>, or set enabled: true in ${join(projectDir, "forge.config.yaml")} and run: mcp-forge -C ${projectDir} generate`,
    );
  }
  const manifest = await generateServer(ir, config, serverDir);
  const readOnly = manifest.tools.filter((t) => t.annotations.readOnlyHint).length;
  log(`Generated ${manifest.tools.length} tool(s) in ${serverDir}${readOnly === manifest.tools.length ? " (all read-only)" : ` (${readOnly} read-only, ${manifest.tools.length - readOnly} enabled with --enable)`}`);

  if (options.install !== false) {
    log("Installing the server's dependencies (npm install)…");
    // npm is a .cmd script on Windows, which needs a shell to run.
    await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: serverDir, shell: process.platform === "win32" });
  }
  // Where the server and the test run get the token: the user's variable or file.
  const tokenEnv: Record<string, string> = {};
  if (config.auth.kind === "token" && options.token) {
    if (options.token.file && config.auth.token_file_env) tokenEnv[config.auth.token_file_env] = resolve(options.token.file);
    else if (options.token.env && process.env[options.token.env]) tokenEnv[config.auth.token_env ?? options.token.env] = process.env[options.token.env]!;
  }
  let results: CheckResult[] | undefined;
  // Testing needs the server's dependencies, so it defaults to on only when they were installed.
  if (options.verify ?? options.install !== false) {
    log("Replaying the samples through the server…");
    // Tools the user enabled explicitly are replayed too: their samples are the user's own commands.
    const enabled = manifest.tools.filter((t) => options.enable?.some((e) => e === t.name || t.actions.some((a) => a.operation_id === e))).map((t) => t.name);
    results = await verifyServer(ir, manifest, { serverDir, env: { ...(options.env ?? {}), ...tokenEnv }, alsoReplay: enabled });
  }

  // What the user passed with -e is part of how the target runs, so clients need it too.
  const env = { ...requiredEnv(manifest), ...(options.env ?? {}) };
  // A token file path is fine to print; a token value never is.
  if (manifest.auth.kind === "token") {
    if (options.token?.file && manifest.auth.token_file_env) env[manifest.auth.token_file_env] = resolve(options.token.file);
    else if (manifest.auth.token_env) env[manifest.auth.token_env] = "<your API token>";
  }
  const serverPath = join(serverDir, "server.mjs");
  const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const claudeCommand = ["claude", "mcp", "add", manifest.server.name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "--", "node", serverPath].map(quote).join(" ");
  const clientConfig = { mcpServers: { [manifest.server.name]: { command: "node", args: [serverPath], ...(Object.keys(env).length ? { env } : {}) } } };
  return { projectDir, serverDir, ir, manifest, ...(results ? { results } : {}), claudeCommand, clientConfig };
}
