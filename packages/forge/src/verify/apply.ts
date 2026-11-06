// Acting on verify results: quarantine tools whose live target broke, and
// fold additive drift (new fields) back into the inferred output schemas.
import type { ForgeIR, JsonSchema } from "../ir/types.ts";
import type { ForgeConfig } from "../curate/config.ts";
import { inferSchema } from "../synth/schema.ts";
import { collectSecrets, redact } from "../synth/redact.ts";
import type { CheckResult } from "./replay.ts";

/** Mark every operation behind a failing tool as quarantined. Returns the new config and what changed. */
export function quarantineFailures(config: ForgeConfig, results: CheckResult[], since: string): { config: ForgeConfig; quarantined: string[] } {
  const next = structuredClone(config);
  const quarantined: string[] = [];
  for (const r of results) {
    if (r.status !== "fail") continue;
    for (const id of r.operation_ids ?? []) {
      const tool = next.tools[id];
      if (!tool || tool.quarantined) continue;
      tool.quarantined = { reason: r.detail.slice(0, 300), since };
      quarantined.push(tool.name);
    }
  }
  return { config: next, quarantined };
}

/**
 * For passing tools with additive drift, re-infer the output schema from the
 * recorded responses plus the live ones, so new fields become documented.
 * Breaking drift is never folded in: it needs a fresh investigation.
 */
export function refreshSchemas(ir: ForgeIR, results: CheckResult[], samples: Map<string, unknown[]>): { ir: ForgeIR; updated: string[] } {
  const next = structuredClone(ir);
  const updated: string[] = [];
  for (const r of results) {
    if (r.status !== "pass" || !r.drift?.added.length) continue;
    for (const id of r.operation_ids ?? []) {
      const op = next.operations.find((o) => o.id === id);
      const live = samples.get(id) ?? [];
      if (!op?.output || live.length === 0) continue;
      const recorded = next.fixtures.filter((f) => f.operation_id === id && f.response !== undefined).map((f) => f.response);
      const secrets = new Set<string>();
      for (const v of live) collectSecrets(v, secrets);
      const merged = inferSchema([...recorded, ...live.map((v) => redact(v, secrets))]);
      const output: JsonSchema = op.output_wrapped_as ? { type: "object", properties: { [op.output_wrapped_as]: merged }, required: [op.output_wrapped_as] } : merged;
      if (JSON.stringify(output) === JSON.stringify(op.output)) continue;
      op.output = output;
      op.unknowns = [...op.unknowns.filter((u) => !u.startsWith("Schema refreshed")), `Schema refreshed from ${live.length} live response(s) on ${new Date().toISOString().slice(0, 10)}.`];
      updated.push(op.name);
    }
  }
  return { ir: next, updated };
}
