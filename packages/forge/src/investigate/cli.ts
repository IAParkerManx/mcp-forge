// CLI investigation recipe: capture `--help` for the command and every
// subcommand through REA's process capture, then run the sample command lines
// the user chose (and only those), and extract the IR.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReaClient, ReaError, REA_VERSION, saveEvidence, type ReaEvidence } from "../rea/client.ts";
import { extractCli, META_COMMANDS, splitArgs, type HelpCapture, type RunCapture } from "../extract/cli.ts";
import { parseHelp } from "../extract/help.ts";
import { isSecretKey, redactLiterals } from "../synth/redact.ts";
import type { ForgeIR } from "../ir/types.ts";
import { forgeDir } from "./web.ts";

export interface CliInvestigation {
  command: string;
  projectDir: string;
  targetName: string;
  /** Command lines (without the program name) to run as samples. They are executed. */
  runs?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** How deep to follow nested subcommands (`git remote add` is depth 2). */
  maxDepth?: number;
  rea?: ReaClient;
}

interface Captured {
  evidence_id: string;
  /** Full Evidence, or REA's partial observation when cleanup could not be verified. */
  record: ReaEvidence | { partial_observation: unknown };
  output: string;
  exit_code: number;
  partial: boolean;
}

type CaptureResult = { frames?: { data: string; raw_data?: string }[]; exit?: { code: number | null } };

function fromResult(result: CaptureResult): { output: string; exit_code: number } {
  return { output: (result.frames ?? []).map((f) => f.raw_data ?? f.data).join(""), exit_code: result.exit?.code ?? -1 };
}

/**
 * REA can finish a run but fail to verify process cleanup afterwards
 * (`cleanup_incomplete`). The command did run, so its partial observation is
 * kept and labeled as such instead of running the command a second time.
 */
function partialCapture(error: unknown): Captured | undefined {
  if (!(error instanceof ReaError)) return undefined;
  const detail = error.detail as { error?: { code?: string; details?: { partial_observation?: { capture?: CaptureResult & { manifest?: { full_scenario_sha256?: string } } } } } };
  const capture = detail?.error?.details?.partial_observation?.capture;
  if (detail?.error?.code !== "cleanup_incomplete" || !capture?.exit) return undefined;
  const digest = capture.manifest?.full_scenario_sha256 ?? createHash("sha256").update(JSON.stringify(capture)).digest("hex");
  return { evidence_id: `rea-partial_${digest.slice(0, 32)}`, record: { partial_observation: capture }, ...fromResult(capture), partial: true };
}

async function capture(rea: ReaClient, command: string, args: string[], options: CliInvestigation, retry: boolean): Promise<Captured> {
  try {
    return await captureOnce(rea, command, args, options);
  } catch (error) {
    // Help captures have no side effects, so one retry is safe.
    if (retry) {
      try {
        return await captureOnce(rea, command, args, options);
      } catch (second) {
        error = second;
      }
    }
    const partial = partialCapture(error);
    if (partial) return partial;
    throw error;
  }
}

async function captureOnce(rea: ReaClient, command: string, args: string[], options: CliInvestigation): Promise<Captured> {
  const evidence = await rea.call<ReaEvidence>("capture_process_scenario", {
    executable: command,
    arguments: args,
    ...(options.cwd ? { working_directory: options.cwd } : {}),
    ...(options.env && Object.keys(options.env).length ? { environment: options.env } : {}),
    // A wide terminal keeps help rows from wrapping.
    terminal: { columns: 200, rows: 50, scrollback: 2000 },
    timeout_ms: 20_000,
    idle_timeout_ms: 10_000,
  });
  return { evidence_id: evidence.evidence_id, record: evidence, ...fromResult(evidence.normalized_result as CaptureResult), partial: false };
}

export async function investigateCli(options: CliInvestigation): Promise<ForgeIR> {
  const dir = forgeDir(options.projectDir);
  const evidenceDir = join(dir, "evidence");
  await mkdir(dir, { recursive: true });
  const secrets = new Set(Object.entries(options.env ?? {}).flatMap(([k, v]) => (isSecretKey(k) && v.length >= 4 ? [v] : [])));
  const rea = options.rea ?? (await ReaClient.connect());
  const partials: string[] = [];
  const keep = async (c: Captured, label: string) => {
    if (c.partial) {
      partials.push(label);
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, `${c.evidence_id}.json`), JSON.stringify({ ...redactLiterals(c.record, secrets), "mcp-forge/redacted": true }, null, 2) + "\n");
    } else {
      await saveEvidence(evidenceDir, c.record as ReaEvidence, secrets);
    }
    return c;
  };
  try {
    const helps: HelpCapture[] = [];
    const maxDepth = options.maxDepth ?? 2;
    const queue: string[][] = [[]];
    while (queue.length) {
      const path = queue.shift()!;
      let c = await keep(await capture(rea, options.command, [...path, "--help"], options, true), [...path, "--help"].join(" "));
      // Some CLIs only answer `help <sub>` or `-h`.
      if (c.exit_code !== 0 || !c.output.trim()) {
        const alt = path.length ? ["help", ...path] : ["-h"];
        const second = await keep(await capture(rea, options.command, alt, options, true), alt.join(" "));
        if (second.exit_code === 0 && second.output.trim()) c = second;
      }
      helps.push({ path, evidence_id: c.evidence_id, text: c.output, exit_code: c.exit_code });
      if (path.length >= maxDepth) continue;
      for (const sub of parseHelp(c.output).subcommands) {
        if (!META_COMMANDS.has(sub.name)) queue.push([...path, sub.name]);
      }
    }

    const runs: RunCapture[] = [];
    for (const [ordinal, line] of (options.runs ?? []).entries()) {
      const argv = splitArgs(line);
      // Sample runs may change state, so they are never retried.
      const c = await keep(await capture(rea, options.command, argv, options, false), line);
      runs.push({ ordinal, argv, evidence_id: c.evidence_id, output: c.output, exit_code: c.exit_code });
    }

    const ir = extractCli({ command: options.command, targetName: options.targetName, reaVersion: REA_VERSION, helps, runs, secrets });
    if (partials.length) {
      ir.notes.push(`REA could not verify process cleanup for: ${partials.join("; ")}. Their output is kept as partial observations (evidence ids starting rea-partial_).`);
    }
    await writeFile(join(dir, "ir.json"), JSON.stringify(ir, null, 2) + "\n");
    return ir;
  } finally {
    if (!options.rea) await rea.close();
  }
}
