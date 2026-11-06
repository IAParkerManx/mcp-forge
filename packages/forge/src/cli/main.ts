#!/usr/bin/env node
// mcp-forge: investigate → plan → generate → verify (or `create` for all at once).
import { Command } from "commander";
import { copyFile, readFile, writeFile, access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { bindingLine, ForgeIR } from "../ir/types.ts";
import { investigateWeb, forgeDir } from "../investigate/web.ts";
import { investigateCli } from "../investigate/cli.ts";
import { investigateElectron } from "../investigate/electron.ts";
import { investigateTauri } from "../investigate/tauri.ts";
import { draftConfig, parseConfig, renderConfig } from "../curate/config.ts";
import { generateServer, buildManifest } from "../codegen/generate.ts";
import { verifyServer } from "../verify/replay.ts";
import { quarantineFailures, refreshSchemas } from "../verify/apply.ts";
import { renderReport, type VerifyRecord } from "../report/html.ts";
import { parseRequest, recordHar, tokenHeader, type TokenSource } from "../investigate/record.ts";

type TokenOpts = { tokenEnv?: string; tokenFile?: string; tokenHeader: string; tokenScheme: string };
/** The token the user pointed at (by variable name or file path); its value is never printed. */
function tokenSource(opts: TokenOpts): TokenSource | undefined {
  if (opts.tokenEnv && opts.tokenFile) throw new Error("use --token-env or --token-file, not both");
  if (!opts.tokenEnv && !opts.tokenFile) return undefined;
  return { ...(opts.tokenEnv ? { env: opts.tokenEnv } : { file: resolve(opts.tokenFile!) }), header: opts.tokenHeader, scheme: opts.tokenScheme };
}
import { detectTarget, runCreate, type DetectedTarget } from "./create.ts";
import { formatDoctor, runDoctor, type TargetArea } from "./doctor.ts";
import { createInterface } from "node:readline/promises";
import { CachedBackend, createBackend, DEFAULT_MODEL, type BackendName } from "../llm/backend.ts";
import { lineDiff, runPlanStages } from "../llm/patch.ts";

const program = new Command()
  .name("mcp-forge")
  .description("Generate MCP servers from evidence REA collects about a target you are authorized to analyze.")
  .option("-C, --project <dir>", "project directory holding .forge/ and forge.config.yaml", ".");

const projectDir = () => resolve(program.opts<{ project: string }>().project);

async function loadIR(): Promise<ForgeIR> {
  const path = join(forgeDir(projectDir()), "ir.json");
  try {
    return ForgeIR.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`Could not read ${path}; run \`mcp-forge investigate\` first. (${(error as Error).message})`);
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const parseEnv = (pairs: string[] = []) =>
  Object.fromEntries(
    pairs.map((kv) => {
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`expected KEY=VALUE, got "${kv}"`);
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }),
  );

/** Ask for a target interactively when `create` is run without one in a terminal. */
async function askForTarget(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("What do you want to turn into an MCP server?");
    console.log("  1) an HTTP API (URL)    2) a command-line tool    3) a website capture (.har)");
    console.log("  4) an Electron app       5) a Tauri app (read-only Docker commands)");
    const choice = (await rl.question("Choose 1-5: ")).trim();
    const prompts: Record<string, string> = {
      "1": "API base URL (e.g. http://127.0.0.1:8000): ",
      "2": "Command name or path (e.g. git, ./bin/tool): ",
      "3": "Path to the .har file: ",
      "4": "Path to the app (main.js or its folder): ",
      "5": "Path to the app folder (containing src-tauri): ",
    };
    if (!prompts[choice]) throw new Error("no target chosen");
    return (await rl.question(prompts[choice]!)).trim();
  } finally {
    rl.close();
  }
}

program
  .command("doctor")
  .description("Check this machine for what each kind of target needs, and how to fix what is missing")
  .option("-t, --target <kind...>", "only check for these: api, web, cli, electron, tauri, android, llm")
  .option("--json", "print the checks as JSON")
  .action(async (opts: { target?: string[]; json?: boolean }) => {
    const known: TargetArea[] = ["api", "web", "cli", "electron", "tauri", "android", "llm"];
    const areas = (opts.target ?? []).map((t) => {
      if (!known.includes(t as TargetArea)) throw new Error(`unknown target kind "${t}" (use: ${known.join(", ")})`);
      return t as TargetArea;
    });
    const checks = await runDoctor({ areas });
    console.log(opts.json ? JSON.stringify(checks, null, 2) : formatDoctor(checks));
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
  });

program
  .command("create")
  .description("Do everything at once: investigate a target, generate a read-only MCP server, install it, test it, and print how to add it to your MCP client")
  .argument("[target]", "a URL (HTTP API), command (CLI), .har file (website), Electron app, or Tauri app folder; asked for if omitted")
  .option("--name <name>", "server name (default: derived from the target)")
  .option("-o, --out <dir>", "project folder (default: ./<name>-mcp)")
  .option("--get <path...>", "API: GET paths to record (default: input-free GETs from the API's OpenAPI document)")
  .option("--run <args...>", "CLI: sample command lines to RUN, e.g. --run 'list --json'")
  .option("--call <call...>", "Electron/Tauri: sample calls to MAKE (JSON arguments)")
  .option("--electron <executable>", "Electron: executable to launch the app with (default: the app's own electron package)")
  .option("-e, --env <KEY=VALUE...>", "environment for samples and the test run")
  .option("--enable <tool...>", "also enable these tools even though they may change data or have unknown effects")
  .option("--token-env <name>", "send an API token read from this environment variable (e.g. RIPPLING_API_TOKEN)")
  .option("--token-file <path>", "send an API token read from this file")
  .option("--token-header <name>", "header for the token", "authorization")
  .option("--token-scheme <scheme>", 'scheme before the token; "" sends the token alone (API-key headers)', "Bearer")
  .option("--no-install", "skip npm install in the generated server (also skips the test run)")
  .option("--no-verify", "skip the test run")
  .action(async (target: string | undefined, opts: { name?: string; out?: string; get?: string[]; run?: string[]; call?: string[]; electron?: string; env?: string[]; enable?: string[]; install: boolean; verify: boolean } & TokenOpts) => {
    if (!target) {
      if (!process.stdin.isTTY) throw new Error("give a target: mcp-forge create <url | command | file.har | app>");
      target = await askForTarget();
    }
    let detected: DetectedTarget = detectTarget(target);
    if (opts.electron) detected = { ...detected, electron: resolve(opts.electron) };
    console.log(`Target: ${detected.kind} (${detected.location})`);
    const result = await runCreate({
      target: detected,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.out ? { outDir: opts.out } : {}),
      gets: opts.get,
      runs: opts.run,
      calls: opts.call,
      env: parseEnv(opts.env),
      enable: opts.enable,
      ...(tokenSource(opts) ? { token: tokenSource(opts)! } : {}),
      install: opts.install,
      verify: opts.install && opts.verify,
      log: (line) => console.log(`• ${line}`),
    });
    if (result.results) {
      for (const r of result.results) console.log(`  ${r.status.toUpperCase().padEnd(5)} ${r.tool.padEnd(28)} ${r.detail}`);
      const failed = result.results.filter((r) => r.status === "fail").length;
      const untested = result.results.filter((r) => r.status === "skip").map((r) => r.tool);
      if (untested.length) {
        console.log(`  Not tested (no successful sample): ${untested.join(", ")}. They may need arguments; try them from your MCP client, or add samples (--get/--run/--call) and run create again.`);
      }
      if (failed) process.exitCode = 1;
    }
    console.log(`\nYour MCP server is in ${result.serverDir}`);
    console.log(`To enable write tools or rename tools, edit ${join(result.projectDir, "forge.config.yaml")} and run: mcp-forge -C ${result.projectDir} generate`);
    console.log(`\nAdd it to Claude Code:\n  ${result.claudeCommand}`);
    console.log(`\nOr to any MCP client config:\n${JSON.stringify(result.clientConfig, null, 2)}`);
    if (Object.keys((result.clientConfig.mcpServers as Record<string, { env?: object }>)[result.manifest.server.name]!.env ?? {}).length) {
      console.log("\nReplace the <placeholders> with credentials for your own account.");
    }
  });

program
  .command("investigate")
  .description("Run REA against a target and extract the capability IR into .forge/ir.json")
  .option("--har <file>", "web: HAR capture exported from your own browser session")
  .option("--source <dir...>", "web: client source directories (extracted bundle) for REA to analyze; used by `plan --enrich`")
  .option("--sensitive <value...>", "web: literal values REA should treat as secrets")
  .option("--cli <command>", "CLI: executable name or path; its --help output is captured for every subcommand")
  .option("--run <args...>", "CLI: sample command lines to RUN (without the program name), e.g. --run 'list --json'")
  .option("--env <KEY=VALUE...>", "CLI: environment for help captures and sample runs")
  .option("--cwd <dir>", "CLI: working directory for help captures and sample runs")
  .option("--depth <n>", "CLI: how deep to follow nested subcommands", "2")
  .option("--electron-app <path>", "Electron: app entry (main.js), directory or .asar to analyze")
  .option("--electron <executable>", "Electron: executable to launch the app with, for --click and --call")
  .option("--click <selector...>", "Electron: CSS selectors REA clicks while observing IPC")
  .option("--call <call...>", "sample calls to MAKE (JSON arguments). Electron: 'api.listNotes(\"work\")'; Tauri: 'op_name({\"lines\":20})'")
  .option("--tauri <src-tauri>", "Tauri (read-only): the app's src-tauri directory; read-only Docker commands are reproduced from source")
  .option("--docker <path>", "Tauri: docker executable (default: docker on PATH)")
  .option("--name <name>", "target name used for the server and env vars")
  .action(async (opts: {
    har?: string;
    source?: string[];
    sensitive?: string[];
    cli?: string;
    run?: string[];
    env?: string[];
    cwd?: string;
    depth: string;
    electronApp?: string;
    electron?: string;
    click?: string[];
    call?: string[];
    tauri?: string;
    docker?: string;
    name?: string;
  }) => {
    if ([opts.har, opts.cli, opts.electronApp, opts.tauri].filter(Boolean).length !== 1) {
      throw new Error("pass exactly one of --har <file>, --cli <command>, --electron-app <path> or --tauri <src-tauri>");
    }
    let ir: ForgeIR;
    if (opts.tauri) {
      const name = opts.name ?? basename(resolve(opts.tauri).replace(/\/(src-tauri|src)\/?$/, "").replace(/\/src-tauri$/, ""));
      ir = await investigateTauri({ sourceDir: opts.tauri, projectDir: projectDir(), targetName: name, ...(opts.docker ? { docker: opts.docker } : {}), calls: opts.call });
    } else if (opts.electronApp) {
      const app = resolve(opts.electronApp);
      const name = opts.name ?? basename(app.replace(/\/(main|index)\.(m?js|cjs)$|\.asar$/i, "").replace(/\/app$/, ""));
      if (opts.call?.length) console.error(`Making ${opts.call.length} sample call(s) in the app; they execute for real.`);
      ir = await investigateElectron({
        appPath: app,
        projectDir: projectDir(),
        targetName: name,
        ...(opts.electron ? { electronExecutable: opts.electron } : {}),
        clicks: opts.click,
        calls: opts.call,
        env: parseEnv(opts.env),
      });
    } else if (opts.cli) {
      const name = opts.name ?? basename(opts.cli).replace(/\.(m?js|cjs|py|sh)$/i, "");
      if (opts.run?.length) console.error(`Running ${opts.run.length} sample command(s) against ${opts.cli}; they execute for real.`);
      ir = await investigateCli({
        command: opts.cli,
        projectDir: projectDir(),
        targetName: name,
        runs: opts.run,
        env: parseEnv(opts.env),
        ...(opts.cwd ? { cwd: resolve(opts.cwd) } : {}),
        maxDepth: Number(opts.depth),
      });
    } else {
      const name = opts.name ?? basename(opts.har!).replace(/\.har$/i, "");
      ir = await investigateWeb({ harPath: opts.har!, projectDir: projectDir(), targetName: name, sensitiveValues: opts.sensitive, sourceDirs: opts.source });
    }
    console.log(`Found ${ir.operations.length} operation(s)${ir.target.kind === "web" ? `, auth: ${ir.auth.kind}${ir.auth.csrf ? ` + csrf (${ir.auth.csrf.header})` : ""}` : ""}.`);
    for (const op of ir.operations) {
      const line = bindingLine(op.binding);
      console.log(`  ${op.name.padEnd(24)} ${op.effects.padEnd(11)} ${line}${op.sample_count ? `  (${op.sample_count} sample${op.sample_count > 1 ? "s" : ""})` : ""}`);
    }
    for (const note of ir.notes) console.log(`  note: ${note}`);
    for (const src of ir.sources) console.log(`  source: ${src.root} (${src.files.length} file(s), REA ${src.evidence_id.slice(0, 15)}…)`);
    console.log("Next: mcp-forge plan");
  });

program
  .command("plan")
  .description("Draft forge.config.yaml for review; optionally ask Claude for suggestions")
  .option("--force", "overwrite an existing forge.config.yaml with a fresh draft")
  .option("--enrich", "Claude reads client code (from `investigate --source`) to document arguments and find code-only endpoints")
  .option("--curate", "Claude proposes tool names, descriptions, effects corrections and groups")
  .option("--cli-help", "CLI targets: Claude reads help text the parser could not fully read and proposes missing arguments")
  .option("--accept", "apply the validated suggestions to forge.config.yaml (a .bak copy is kept)")
  .option("--llm-send-samples", "also send observed values (redacted) to Claude; off by default")
  .option("--model <id>", "Claude model for the LLM stages", DEFAULT_MODEL)
  .option("--llm-backend <name>", "auto | claude-code (your `claude` CLI sign-in) | anthropic-api (API key)", "auto")
  .action(async (opts: { force?: boolean; enrich?: boolean; curate?: boolean; cliHelp?: boolean; accept?: boolean; llmSendSamples?: boolean; model: string; llmBackend: string }) => {
    const anyStage = Boolean(opts.enrich || opts.curate || opts.cliHelp);
    const ir = await loadIR();
    const path = join(projectDir(), "forge.config.yaml");
    if (!(await exists(path)) || opts.force) {
      await writeFile(path, renderConfig(draftConfig(ir), ir));
      console.log(`Wrote ${path}. Read-only tools are enabled; enable write/destructive tools deliberately.`);
    } else if (!anyStage) {
      console.log(`${path} already exists; review it, or pass --force to redraft.`);
    }
    if (!anyStage) return;

    const before = await readFile(path, "utf8");
    const config = parseConfig(before);
    if (!["auto", "claude-code", "anthropic-api"].includes(opts.llmBackend)) throw new Error(`unknown --llm-backend "${opts.llmBackend}"`);
    const inner = createBackend(opts.llmBackend as BackendName, opts.model);
    const backend = new CachedBackend(inner, join(forgeDir(projectDir()), "llm-cache"));
    console.error(`Asking ${inner.model}${opts.llmSendSamples ? " (with redacted samples)" : " (schemas and code only, no observed values)"}…`);
    const { config: suggested, reports } = await runPlanStages(ir, config, backend, { cliHelp: opts.cliHelp, enrich: opts.enrich, curate: opts.curate }, { sendSamples: Boolean(opts.llmSendSamples) });
    for (const r of reports) {
      if (r.skipped) {
        console.log(`[${r.stage}] skipped: ${r.skipped}`);
        continue;
      }
      console.log(`[${r.stage}]${r.cached ? " (cached)" : ""} ${r.accepted.length} accepted, ${r.rejected.length} rejected`);
      for (const a of r.accepted) console.log(`  + ${a}`);
      for (const x of r.rejected) console.log(`  - ${x}`);
      for (const n of r.notes) console.log(`  note: ${n}`);
    }
    // Compare normalized renderings so hand formatting is not reported as a change.
    const base = renderConfig(config, ir);
    const after = renderConfig(suggested, ir);
    if (after === base) {
      console.log(reports.every((r) => r.skipped) ? "No suggestions: every stage was skipped; forge.config.yaml is unchanged." : "No changes suggested.");
      return;
    }
    console.log(`\n${lineDiff(base, after)}\n`);
    if (opts.accept) {
      await copyFile(path, `${path}.bak`);
      await writeFile(path, after);
      console.log(`Applied to ${path} (previous version in forge.config.yaml.bak).`);
    } else {
      const suggestedPath = join(projectDir(), "forge.config.suggested.yaml");
      await writeFile(suggestedPath, after);
      console.log(`Wrote ${suggestedPath}. Review it, then rerun with --accept or merge by hand.`);
    }
  });

program
  .command("generate")
  .description("Generate a standalone MCP server from the IR and forge.config.yaml")
  .option("-o, --out <dir>", "output directory (default: <project>/server)")
  .action(async (opts: { out?: string }) => {
    opts.out ??= join(projectDir(), "server");
    const ir = await loadIR();
    const config = parseConfig(await readFile(join(projectDir(), "forge.config.yaml"), "utf8"));
    const manifest = await generateServer(ir, config, resolve(opts.out));
    console.log(`Generated ${manifest.tools.length} tool(s) in ${resolve(opts.out)}. Run \`npm install\` there, then \`node server.mjs\`.`);
  });

program
  .command("verify")
  .description("Start the generated server and replay captured samples against the target")
  .requiredOption("-s, --server <dir>", "generated server directory")
  .option("--include-writes", "also replay write/destructive tools (mutates the target)")
  .option("-e, --env <KEY=VALUE...>", "environment for the server (credentials for your own account)")
  .option("--quarantine", "mark failing tools as quarantined in forge.config.yaml so the next generate leaves them out")
  .option("--update-schemas", "fold additive drift (new response fields) into the inferred output schemas")
  .action(async (opts: { server: string; includeWrites?: boolean; env?: string[]; quarantine?: boolean; updateSchemas?: boolean }) => {
    const ir = await loadIR();
    const config = parseConfig(await readFile(join(projectDir(), "forge.config.yaml"), "utf8"));
    const manifest = buildManifest(ir, config);
    const env = parseEnv(opts.env);
    for (const name of [
      manifest.server.base_url_env,
      manifest.server.command_env,
      manifest.server.cwd_env,
      manifest.server.cdp_url_env,
      manifest.server.electron_env,
      manifest.server.app_env,
      manifest.auth.cookie_env,
      manifest.auth.token_env,
      manifest.auth.token_file_env,
      ...Object.values(manifest.auth.login_credentials_env ?? {}),
    ]) {
      if (name && process.env[name] && !(name in env)) env[name] = process.env[name]!;
    }
    const samples = new Map<string, unknown[]>();
    const results = await verifyServer(ir, manifest, {
      serverDir: resolve(opts.server),
      env,
      includeWrites: opts.includeWrites,
      onSample: (id, value) => samples.set(id, [...(samples.get(id) ?? []), value]),
    });
    for (const r of results) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.tool.padEnd(24)} ${r.detail}`);
    const at = new Date().toISOString();
    await writeFile(join(forgeDir(projectDir()), "verify.json"), JSON.stringify({ at, server: resolve(opts.server), include_writes: Boolean(opts.includeWrites), results }, null, 2) + "\n");

    const configPath = join(projectDir(), "forge.config.yaml");
    if (opts.quarantine) {
      const { config: next, quarantined } = quarantineFailures(config, results, at.slice(0, 10));
      if (quarantined.length) {
        await copyFile(configPath, `${configPath}.bak`);
        await writeFile(configPath, renderConfig(next, ir));
        console.log(`Quarantined ${quarantined.join(", ")} in forge.config.yaml (previous version in .bak). Run \`mcp-forge generate\` to rebuild without them.`);
      }
    }
    if (opts.updateSchemas) {
      const { ir: next, updated } = refreshSchemas(ir, results, samples);
      if (updated.length) {
        await writeFile(join(forgeDir(projectDir()), "ir.json"), JSON.stringify(next, null, 2) + "\n");
        console.log(`Refreshed output schemas for ${updated.join(", ")}. Run \`mcp-forge generate\` to publish them.`);
      } else console.log("No additive drift to fold into schemas.");
    }
    if (results.some((r) => r.status === "fail")) process.exitCode = 1;
  });

program
  .command("record")
  .description("Record a HAR by calling an HTTP API directly (for APIs without a browser UI). Only GET unless --allow-writes.")
  .requiredOption("--base <url>", "API base URL, e.g. http://127.0.0.1:5001")
  .requiredOption("-o, --out <file>", "HAR file to write")
  .option("--allow-writes", "allow non-GET requests (they may change data)")
  .option("--token-env <name>", "send an API token read from this environment variable (e.g. RIPPLING_API_TOKEN)")
  .option("--token-file <path>", "send an API token read from this file")
  .option("--token-header <name>", "header for the token", "authorization")
  .option("--token-scheme <scheme>", 'scheme before the token; "" sends the token alone (API-key headers)', "Bearer")
  .argument("<requests...>", 'requests like "/health", "GET /status?limit=5" or "POST /run {\"x\":1}"')
  .action(async (requests: string[], opts: { base: string; out: string; allowWrites?: boolean } & TokenOpts) => {
    const parsed = requests.map(parseRequest);
    const source = tokenSource(opts);
    const secretHeaders = source ? await tokenHeader(source) : undefined;
    const { entries, statuses } = await recordHar({ baseUrl: opts.base, requests: parsed, out: resolve(opts.out), allowWrites: opts.allowWrites, ...(secretHeaders ? { secretHeaders } : {}) });
    parsed.forEach((r, i) => console.log(`  ${String(statuses[i]).padEnd(4)} ${r.method} ${r.path}`));
    console.log(`Recorded ${entries} request(s) to ${resolve(opts.out)}. Next: mcp-forge investigate --har ${opts.out}`);
  });

program
  .command("report")
  .description("Write an HTML evidence report: sources, confidence, unknowns, schemas and the latest verify results")
  .option("-o, --out <file>", "output file", "")
  .action(async (opts: { out: string }) => {
    const ir = await loadIR();
    const configPath = join(projectDir(), "forge.config.yaml");
    const config = (await exists(configPath)) ? parseConfig(await readFile(configPath, "utf8")) : undefined;
    const verifyPath = join(forgeDir(projectDir()), "verify.json");
    const verify = (await exists(verifyPath)) ? (JSON.parse(await readFile(verifyPath, "utf8")) as VerifyRecord) : undefined;
    const out = resolve(opts.out || join(forgeDir(projectDir()), "report.html"));
    await writeFile(out, renderReport(ir, config, verify));
    console.log(`Wrote ${out}`);
  });

program.parseAsync().catch((error: Error) => {
  console.error(`mcp-forge: ${error.message}`);
  process.exitCode = 1;
});
