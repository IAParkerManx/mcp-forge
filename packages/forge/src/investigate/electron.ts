// Electron investigation recipe:
// 1. REA statically analyzes the app (contextBridge APIs, IPC pairing). Always.
// 2. Optionally, REA launches the app and observes IPC while clicking through
//    a scenario (`--click`): channels and argument/result shapes, no values.
// 3. Optionally, forge launches the app with a private debugging port and makes
//    the sample calls the user listed (`--call`), for types and fixtures.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ReaClient, REA_VERSION, saveEvidence, type ReaEvidence } from "../rea/client.ts";
import { extractElectron, type ObservedIpc, type SampleCall } from "../extract/electron.ts";
import { isSecretKey } from "../synth/redact.ts";
import type { ForgeIR } from "../ir/types.ts";
import { forgeDir } from "./web.ts";
// @ts-expect-error untyped runtime shared with generated servers
import { createElectronRuntime } from "../../templates/server/lib/electron-runtime.mjs";

export interface ElectronInvestigation {
  /** App entry (main.js), app directory or .asar. */
  appPath: string;
  projectDir: string;
  targetName: string;
  /** Electron executable used to launch the app for scenarios and sample calls. */
  electronExecutable?: string;
  /** CSS selectors REA clicks while observing IPC. */
  clicks?: string[];
  /** Sample calls like `desknotes.createNote({"title":"x"})`. They execute for real. */
  calls?: string[];
  env?: Record<string, string>;
  rea?: ReaClient;
}

/** Parse `api.member(<json args>)`; arguments must be JSON values, nothing is evaluated. */
export function parseCall(text: string): { api: string; member: string; args: unknown[] } {
  const m = /^\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!m) throw new Error(`expected api.member(args), got: ${text}`);
  let args: unknown;
  try {
    args = JSON.parse(`[${m[3]}]`);
  } catch {
    throw new Error(`arguments of ${m[1]}.${m[2]} must be JSON values: ${m[3]}`);
  }
  return { api: m[1]!, member: m[2]!, args: args as unknown[] };
}

async function appRootOf(appPath: string): Promise<string> {
  return (await stat(appPath)).isDirectory() ? appPath : dirname(appPath);
}

async function listFiles(root: string): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(m?js|cjs|ts|html?)$/i.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    if (relative(root, full).split(/[\\/]/).includes("node_modules")) continue;
    out.push({ path: relative(root, full), sha256: createHash("sha256").update(await readFile(full)).digest("hex") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function investigateElectron(options: ElectronInvestigation): Promise<ForgeIR> {
  const dir = forgeDir(options.projectDir);
  const evidenceDir = join(dir, "evidence");
  await mkdir(dir, { recursive: true });
  const appPath = resolve(options.appPath);
  const appRoot = await appRootOf(appPath);
  const secrets = new Set(Object.entries(options.env ?? {}).flatMap(([k, v]) => (isSecretKey(k) && v.length >= 4 ? [v] : [])));
  const notes: string[] = [];
  const rea = options.rea ?? (await ReaClient.connect({ env: options.env ?? {} }));
  try {
    const staticEvidence = await rea.call<ReaEvidence>("analyze_javascript_application", { input_path: appRoot, format: "directory" });
    await saveEvidence(evidenceDir, staticEvidence, secrets);

    let scenarioEvidenceId: string | undefined;
    let observed: ObservedIpc[] | undefined;
    let pageHint: string | undefined;
    if (options.clicks?.length) {
      if (!options.electronExecutable) throw new Error("--click needs --electron <executable> to launch the app");
      const actions = [{ step_id: "settle", kind: "wait", duration_ms: 1000 }];
      options.clicks.forEach((selector, i) => actions.push({ step_id: `click-${i + 1}`, kind: "click", selector } as never, { step_id: `wait-${i + 1}`, kind: "wait", duration_ms: 400 }));
      const scenario = await rea.call<ReaEvidence>("capture_electron_scenario", { executable_path: resolve(options.electronExecutable), application_path: appPath, actions });
      await saveEvidence(evidenceDir, scenario, secrets);
      scenarioEvidenceId = scenario.evidence_id;
      const result = scenario.normalized_result as { ipc?: { events: (ObservedIpc & { kind: string })[] }; windows?: { url: string }[] };
      observed = (result.ipc?.events ?? []).filter((e) => e.channel).map((e) => ({ channel: e.channel, argument_shapes: e.argument_shapes ?? [], result_shape: e.result_shape ?? null, error: Boolean(e.error) }));
      const url = result.windows?.[0]?.url;
      if (url?.startsWith("file:")) pageHint = basename(new URL(url).pathname);
    }

    const calls: SampleCall[] = [];
    if (options.calls?.length) {
      if (!options.electronExecutable) throw new Error("--call needs --electron <executable> to launch the app");
      const runtime = createElectronRuntime(
        { server: { electron_env: "FORGE_ELECTRON", default_electron: resolve(options.electronExecutable), default_app: appPath } },
        { ...process.env, ...options.env },
      );
      try {
        for (const [ordinal, text] of options.calls.entries()) {
          const { api, member, args } = parseCall(text);
          const binding = { api, member, params: args.map((_, i) => `a${i}`), ipc_mode: "unknown" };
          const named = Object.fromEntries(args.map((a, i) => [`a${i}`, a]));
          const result = (await runtime.invoke({ binding }, named)) as { ok: boolean; value?: unknown; error?: string };
          calls.push({ ordinal, api, member, args, ...result });
          if (!result.ok) notes.push(`Sample call ${text} failed: ${result.error}`);
        }
      } finally {
        runtime.close();
      }
    }

    const ir = await extractElectron({
      targetName: options.targetName,
      reaVersion: REA_VERSION,
      appRoot,
      appPath,
      ...(options.electronExecutable ? { electronExecutable: resolve(options.electronExecutable) } : {}),
      staticEvidence,
      ...(scenarioEvidenceId ? { scenarioEvidenceId } : {}),
      ...(observed ? { observed } : {}),
      calls,
      ...(pageHint ? { pageHint } : {}),
      secrets,
    });
    ir.notes.push(...notes);
    // Client code for `plan --enrich`, tied to REA's static Evidence.
    ir.sources = [{ evidence_id: staticEvidence.evidence_id, root: appRoot, files: await listFiles(appRoot) }];
    await writeFile(join(dir, "ir.json"), JSON.stringify(ir, null, 2) + "\n");
    return ir;
  } finally {
    if (!options.rea) await rea.close();
  }
}
