// `mcp-forge doctor`: check what this machine needs for each kind of target,
// and say how to fix what is missing. Checks only read state; nothing is
// installed or changed.
import { execFile } from "node:child_process";
import { REA_VERSION } from "../rea/client.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export type TargetArea = "general" | "api" | "web" | "cli" | "electron" | "tauri" | "android" | "llm";

export interface DoctorCheck {
  area: TargetArea;
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/** Run a command without a shell (except npm/npx on Windows, which are .cmd scripts). */
export const realExec: Exec = (command, args, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    const shell = process.platform === "win32" && /^(npm|npx)$/.test(command);
    execFile(command, args, { timeout: timeoutMs, shell, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error as Error | null)?.message ?? "") });
    });
  });

const MIN_NODE: [number, number] = [22, 19];

export interface DoctorOptions {
  /** Limit to these areas (general is always included). */
  areas?: TargetArea[];
  exec?: Exec;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const exec = options.exec ?? realExec;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wanted = (area: TargetArea) => area === "general" || !options.areas?.length || options.areas.includes(area);
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // General: Node, npm, REA.
  const version = options.nodeVersion ?? process.versions.node;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  add({
    area: "general",
    name: "Node.js",
    status: nodeOk ? "ok" : "fail",
    detail: `v${version}${nodeOk ? "" : ` (needs ${MIN_NODE.join(".")} or newer)`}`,
    ...(nodeOk ? {} : { fix: "Install Node.js 24 LTS from https://nodejs.org (or with nvm: nvm install 24)." }),
  });
  const npm = await exec("npm", ["--version"], 30_000);
  add({
    area: "general",
    name: "npm",
    status: npm.ok ? "ok" : "fail",
    detail: npm.ok ? npm.stdout.trim() : "not found",
    ...(npm.ok ? {} : { fix: "npm comes with Node.js; reinstall Node.js. `create` uses it to install generated servers." }),
  });
  const rea = await exec("npx", ["-y", `rea-agents@${REA_VERSION}`, "--version"], 180_000);
  const reaVersion = rea.stdout.trim().split("\n").at(-1) ?? "";
  add({
    area: "general",
    name: `REA ${REA_VERSION}`,
    status: rea.ok && reaVersion === REA_VERSION ? "ok" : "fail",
    detail: rea.ok ? `starts (reports ${reaVersion || "no version"})` : "could not start through npx",
    ...(rea.ok && reaVersion === REA_VERSION ? {} : { fix: `Check network access to the npm registry, then run: npx -y rea-agents@${REA_VERSION} --version` }),
  });

  if (wanted("api") || wanted("web")) {
    add({ area: "api", name: "HTTP APIs and websites", status: "ok", detail: "no extra tools needed (HAR captures come from your browser's DevTools)" });
  }

  if (wanted("cli")) {
    if (platform === "darwin") {
      const swift = await exec("xcrun", ["--find", "swift"], 30_000);
      add({
        area: "cli",
        name: "Swift (for REA process capture)",
        status: swift.ok ? "ok" : "fail",
        detail: swift.ok ? swift.stdout.trim() : "xcrun could not find swift",
        ...(swift.ok ? {} : { fix: "Install Apple's Command Line Tools: xcode-select --install" }),
      });
    } else if (platform === "linux") {
      const ps = await exec("ps", ["--version"], 10_000);
      const procps = ps.ok && /procps/i.test(ps.stdout + ps.stderr);
      add({
        area: "cli",
        name: "procps ps (for REA process capture)",
        status: procps ? "ok" : "fail",
        detail: procps ? (ps.stdout.trim().split("\n")[0] ?? "") : "ps is missing or not procps",
        ...(procps ? {} : { fix: "Install procps (Debian/Ubuntu: apt install procps; Alpine: apk add procps)." }),
      });
    } else if (platform === "win32") {
      add({
        area: "cli",
        name: "REA process capture",
        status: "fail",
        detail: "REA cannot capture terminal processes on native Windows",
        fix: "Run mcp-forge inside WSL for command-line targets.",
      });
    }
  }

  if (wanted("electron")) {
    add({
      area: "electron",
      name: "Electron apps",
      status: "info",
      detail: "uses the app's own electron package to launch it; pass --electron <executable> for packaged apps",
    });
  }

  if (wanted("tauri")) {
    const docker = await exec("docker", ["version", "--format", "{{.Server.Version}}"], 30_000);
    const client = docker.ok || /Cannot connect|daemon/i.test(docker.stderr);
    add({
      area: "tauri",
      name: "Docker (Tauri targets run read-only docker commands)",
      status: docker.ok ? "ok" : client ? "warn" : "fail",
      detail: docker.ok ? `engine ${docker.stdout.trim()}` : client ? "docker is installed but the engine is not running" : "docker not found",
      ...(docker.ok ? {} : { fix: client ? "Start Docker Desktop (or the docker service) before creating or using the server." : "Install Docker Desktop: https://docs.docker.com/get-docker/" }),
    });
  }

  if (wanted("android")) {
    add({ area: "android", name: "Android apps", status: "info", detail: "not supported yet (the Android target is shelved)" });
  }

  if (wanted("llm")) {
    const apiKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
    const claude = await exec("claude", ["auth", "status"], 30_000);
    let loggedIn = false;
    try {
      loggedIn = claude.ok && (JSON.parse(claude.stdout) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      loggedIn = false;
    }
    add({
      area: "llm",
      name: "Claude for optional plan --enrich/--curate/--cli-help",
      status: apiKey || loggedIn ? "ok" : "warn",
      detail: apiKey ? "Anthropic API credential found in the environment" : loggedIn ? "Claude Code CLI is signed in" : claude.ok || claude.stdout ? "Claude Code CLI is installed but not signed in" : "no Claude credential found (optional)",
      ...(apiKey || loggedIn ? {} : { fix: "Optional. Run `claude auth login` (Claude subscription) or set ANTHROPIC_API_KEY." }),
    });
  }
  return checks;
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  let area: TargetArea | undefined;
  const titles: Record<TargetArea, string> = { general: "General", api: "HTTP APIs and websites", web: "Websites", cli: "Command-line tools", electron: "Electron apps", tauri: "Tauri apps", android: "Android apps", llm: "Optional: Claude suggestions" };
  for (const c of checks) {
    if (c.area !== area) {
      area = c.area;
      lines.push(`${lines.length ? "\n" : ""}${titles[c.area]}`);
    }
    lines.push(`  ${ICON[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`      → ${c.fix}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  lines.push(`\n${failed ? `${failed} problem(s) to fix` : "Ready"}${warned ? `, ${warned} warning(s)` : ""}.`);
  return lines.join("\n");
}
