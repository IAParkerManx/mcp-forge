// Orchestrates the optional LLM stages for `mcp-forge plan`: run each stage,
// validate its suggestion, and produce a reviewable diff of forge.config.yaml.
// Nothing is applied unless the caller accepts it.
import type { ForgeIR } from "../ir/types.ts";
import { ForgeConfig } from "../curate/config.ts";
import type { LlmBackend } from "./backend.ts";
import type { ContextOptions } from "./context.ts";
import { applyEnrich, runEnrich, type EnrichSuggestion } from "./enrich.ts";
import { applyCurate, runCurate, type CurateSuggestion } from "./curate.ts";
import { applyCliHelp, runCliHelp, type CliHelpSuggestion } from "./clihelp.ts";

export interface StageReport {
  stage: string;
  accepted: string[];
  rejected: string[];
  notes: string[];
  /** Set when the stage did not run; the deterministic config is kept. */
  skipped?: string;
  cached?: boolean;
}

export interface PlanStages {
  cliHelp?: boolean;
  enrich?: boolean;
  curate?: boolean;
}

export async function runPlanStages(
  ir: ForgeIR,
  config: ForgeConfig,
  backend: LlmBackend,
  stages: PlanStages,
  options: ContextOptions,
): Promise<{ config: ForgeConfig; reports: StageReport[] }> {
  let current = config;
  const reports: StageReport[] = [];

  // Fix arguments first, then document them, then design tools around them.
  if (stages.cliHelp) {
    const result = await runCliHelp(ir, current, backend);
    if (result.status === "ok") {
      const applied = applyCliHelp(ir, current, result.output as CliHelpSuggestion);
      current = applied.config;
      reports.push({ ...applied.report, cached: result.cached });
    } else {
      reports.push({ stage: "cli-help", accepted: [], rejected: [], notes: [], skipped: skipReason(result) });
    }
  }
  if (stages.enrich) {
    const { result, excerpts } = await runEnrich(ir, current, backend, options);
    if (result.status === "ok") {
      const applied = applyEnrich(ir, current, result.output as EnrichSuggestion, excerpts);
      current = applied.config;
      reports.push({ ...applied.report, cached: result.cached });
    } else {
      reports.push({ stage: "enrich", accepted: [], rejected: [], notes: [], skipped: skipReason(result) });
    }
  }
  if (stages.curate) {
    const result = await runCurate(ir, current, backend, options);
    if (result.status === "ok") {
      const applied = applyCurate(ir, current, result.output as CurateSuggestion);
      current = applied.config;
      reports.push({ ...applied.report, cached: result.cached });
    } else {
      reports.push({ stage: "curate", accepted: [], rejected: [], notes: [], skipped: skipReason(result) });
    }
  }
  // Whatever survived validation must still be a valid config.
  return { config: ForgeConfig.parse(current), reports };
}

function skipReason(result: { status: "refused"; category: string | null } | { status: "unavailable"; reason: string } | { status: string }): string {
  if (result.status === "refused") {
    const r = result as { category: string | null };
    return `Claude declined this request${r.category ? ` (${r.category})` : ""}; kept the deterministic config`;
  }
  return (result as { reason: string }).reason ?? "unavailable";
}

/** Minimal unified-style line diff (LCS), enough to review a config change. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < a.length && (j === b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  // Keep changed lines with two lines of context.
  const keep = new Set<number>();
  out.forEach((line, k) => {
    if (!line.startsWith("  ")) for (let d = -2; d <= 2; d++) keep.add(k + d);
  });
  const lines: string[] = [];
  let last = -1;
  for (let k = 0; k < out.length; k++) {
    if (!keep.has(k)) continue;
    if (last !== -1 && k !== last + 1) lines.push("  …");
    lines.push(out[k]!);
    last = k;
  }
  return lines.join("\n");
}
