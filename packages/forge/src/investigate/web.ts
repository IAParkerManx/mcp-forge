// Web investigation recipe: decode a HAR through REA, persist the Evidence,
// and extract the IR. Optional client source trees are analyzed by REA too, so
// `--enrich` can quote code with an Evidence id behind it.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ReaClient, REA_VERSION, saveEvidence, type ReaEvidence } from "../rea/client.ts";
import { captureSecrets, extractWeb, toObservations } from "../extract/har.ts";
import type { ForgeIR } from "../ir/types.ts";

export interface WebInvestigation {
  harPath: string;
  projectDir: string;
  targetName: string;
  /** Literal values to mark sensitive in REA (e.g. a password typed during capture). */
  sensitiveValues?: string[];
  /** Client source directories (extracted bundle, ASAR contents) to analyze. */
  sourceDirs?: string[];
  rea?: ReaClient;
}

export function forgeDir(projectDir: string): string {
  return join(projectDir, ".forge");
}

const SOURCE_FILE = /\.(m?js|cjs|jsx|ts|tsx|html?)$/i;

async function listSourceFiles(root: string): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    const rel = relative(root, full);
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    out.push({ path: rel, sha256: createHash("sha256").update(await readFile(full)).digest("hex") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function analyzeSources(rea: ReaClient, dirs: string[], evidenceDir: string): Promise<ForgeIR["sources"]> {
  const sources: ForgeIR["sources"] = [];
  for (const dir of dirs) {
    const root = resolve(dir);
    // The summary view keeps the reply small; it names the full analysis as its parent.
    const view = await rea.call<ReaEvidence>("analyze_javascript_application", { input_path: root, format: "directory", detail: "summary" });
    const parent = (view.parameters as { parent_evidence_id?: string } | undefined)?.parent_evidence_id ?? view.evidence_id;
    await saveEvidence(evidenceDir, view, new Set());
    sources.push({ evidence_id: parent, root, files: await listSourceFiles(root) });
  }
  return sources;
}

export async function investigateWeb(options: WebInvestigation): Promise<ForgeIR> {
  const dir = forgeDir(options.projectDir);
  await mkdir(dir, { recursive: true });
  const rea = options.rea ?? (await ReaClient.connect());
  try {
    const evidence = await rea.call<ReaEvidence>("inspect_web_network_capture", {
      capture_path: resolve(options.harPath),
      format: "har",
      ...(options.sensitiveValues?.length ? { sensitive_values: options.sensitiveValues } : {}),
    });
    const secrets = captureSecrets(toObservations(evidence));
    for (const value of options.sensitiveValues ?? []) secrets.add(value);
    await saveEvidence(join(dir, "evidence"), evidence, secrets);
    const ir = extractWeb(evidence, { targetName: options.targetName, reaVersion: REA_VERSION });
    if (options.sourceDirs?.length) ir.sources = await analyzeSources(rea, options.sourceDirs, join(dir, "evidence"));
    await writeFile(join(dir, "ir.json"), JSON.stringify(ir, null, 2) + "\n");
    return ir;
  } finally {
    if (!options.rea) await rea.close();
  }
}
