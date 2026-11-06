// Tauri investigation (read-only): read the app's Rust source, reproduce the
// commands that are single read-only Docker calls, and optionally run the
// sample calls the user lists (`--call 'op_name({"lines":20})'`) for fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractTauri, readRustSources } from "../extract/tauri.ts";
import type { Fixture, ForgeIR } from "../ir/types.ts";
import { forgeDir } from "./web.ts";
// @ts-expect-error untyped runtime shared with generated servers
import { createCliRuntime } from "../../templates/server/lib/cli-runtime.mjs";

export interface TauriInvestigation {
  /** The app's `src-tauri` directory (or its `src`). */
  sourceDir: string;
  projectDir: string;
  targetName: string;
  docker?: string;
  calls?: string[];
}

/** `op_name({"arg": 1})` or `op_name()`; arguments are one JSON object, nothing is evaluated. */
export function parseOpCall(text: string): { name: string; args: Record<string, unknown> } {
  const m = /^\s*([a-z][\w]*)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!m) throw new Error(`expected operation_name({json}), got: ${text}`);
  if (!m[2]!.trim()) return { name: m[1]!, args: {} };
  let args: unknown;
  try {
    args = JSON.parse(m[2]!);
  } catch {
    throw new Error(`arguments of ${m[1]} must be one JSON object: ${m[2]}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`arguments of ${m[1]} must be one JSON object`);
  return { name: m[1]!, args: args as Record<string, unknown> };
}

export async function investigateTauri(options: TauriInvestigation): Promise<ForgeIR> {
  const dir = forgeDir(options.projectDir);
  await mkdir(dir, { recursive: true });
  const root = resolve(options.sourceDir);
  const ir = extractTauri({ targetName: options.targetName, appRoot: root, sources: await readRustSources(root), ...(options.docker ? { docker: options.docker } : {}) });

  const fixtures: Fixture[] = [];
  if (options.calls?.length) {
    const runtime = createCliRuntime({ server: { default_command: options.docker ?? "docker" } }, process.env);
    for (const [ordinal, text] of options.calls.entries()) {
      const { name, args } = parseOpCall(text);
      const op = ir.operations.find((o) => o.name === name);
      if (!op) throw new Error(`--call names ${name}, which is not a reproduced command (${ir.operations.map((o) => o.name).join(", ")})`);
      // Every reproduced operation is a read-only Docker call, so running it is safe.
      const run = (await runtime.invoke(op, args)) as { exit_code: number; stdout: string; stderr: string };
      const stdout = run.stdout.replace(/\s+$/, "");
      fixtures.push({ operation_id: op.id, ordinal, arguments: args, exit_code: run.exit_code, derived: [], response: { stdout }, evidence: { evidence_id: op.evidence[0]!.evidence_id, note: `sample call ${text}` } });
      op.sample_count += 1;
      if (run.exit_code === 0) {
        op.confidence = "observed";
        op.unknowns = op.unknowns.filter((u) => !u.startsWith("Reproduced from the Rust source"));
      } else ir.notes.push(`Sample call ${text} exited ${run.exit_code}: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
    }
  }
  ir.fixtures = fixtures;
  await writeFile(join(dir, "ir.json"), JSON.stringify(ir, null, 2) + "\n");
  return ir;
}
