// Replay verification: start a generated server as an MCP client would, call
// each tool with arguments recovered from the capture, and check the live
// response still matches the inferred output schema.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { join } from "node:path";
import { fixtureSucceeded, type ForgeIR } from "../ir/types.ts";
import type { Manifest } from "../codegen/generate.ts";
import { driftOf, emptyDrift, hasDrift, isBreaking, mergeDrift, type Drift } from "./drift.ts";

export interface CheckResult {
  tool: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  /** Operations behind the tool (one, or several for a group). */
  operation_ids?: string[];
  /** How live responses differed from the inferred output schema. */
  drift?: Drift;
}

export interface VerifyOptions {
  serverDir: string;
  env: Record<string, string>;
  /** Also replay write/destructive tools. Off by default: replay mutates the target. */
  includeWrites?: boolean;
  /** Replay these tools regardless of effects (e.g. ones the user explicitly enabled and sampled). */
  alsoReplay?: string[];
  /** Receives each live response that came back successfully, e.g. to refresh schemas. */
  onSample?: (operationId: string, value: unknown) => void;
}

function describeDrift(d: Drift): string {
  const parts: string[] = [];
  if (d.missing.length) parts.push(`missing ${d.missing.slice(0, 3).join(", ")}`);
  if (d.changed.length) parts.push(`type changed ${d.changed.slice(0, 3).map((c) => `${c.path} ${c.expected}→${c.actual}`).join(", ")}`);
  if (d.added.length) parts.push(`${d.added.length} new field(s): ${d.added.slice(0, 4).join(", ")}${d.added.length > 4 ? ", …" : ""}`);
  return parts.join("; ");
}

function pointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "/" || pointer === "") return value;
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((v, key) => (v != null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined), value);
}

function validate(schema: Record<string, unknown>, value: unknown): string[] {
  const result = fromJsonSchema(schema)["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("unexpected async validator");
  return result.issues ? result.issues.map((i) => `${(i.path ?? []).map((p) => (typeof p === "object" ? p.key : p)).join(".") || "(root)"}: ${i.message}`) : [];
}

export async function verifyServer(ir: ForgeIR, manifest: Manifest, options: VerifyOptions): Promise<CheckResult[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(options.serverDir, "server.mjs")],
    env: { PATH: process.env.PATH ?? "", ...options.env, FORGE_VERIFY_RAW: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-forge-verify", version: "0.1.0" });
  await client.connect(transport);
  const results: CheckResult[] = [];
  try {
    const listed = (await client.listTools()).tools;
    type Tool = Manifest["tools"][number];
    type Action = Tool["actions"][number];
    // operation id → the tool (and group action) that exposes it
    const replayable = new Map<string, { tool: Tool; action: Action }>();
    const tools = new Map<string, Tool>();
    for (const tool of manifest.tools) {
      const live = listed.find((t) => t.name === tool.name);
      if (!live) results.push({ tool: tool.name, status: "fail", detail: "not returned by tools/list" });
      else if (!live.annotations || live.annotations.readOnlyHint === undefined) results.push({ tool: tool.name, status: "fail", detail: "missing tool annotations" });
      else {
        tools.set(tool.name, tool);
        const forced = options.alsoReplay?.includes(tool.name) ?? false;
        for (const action of tool.actions) {
          if (action.effects === "read" || options.includeWrites || forced) replayable.set(action.operation_id, { tool, action });
        }
        const skipped = tool.actions.filter((a) => a.effects !== "read" && !options.includeWrites && !forced);
        if (skipped.length === tool.actions.length) {
          results.push({ tool: tool.name, status: "skip", detail: `${tool.meta["mcp-forge/effects"]} tool; pass --include-writes to replay it` });
          tools.delete(tool.name);
        }
      }
    }

    // Replay in capture order so values produced by earlier calls (a created
    // id, a listed id) are taken from the live responses, not the stale capture.
    const liveBodies = new Map<number, unknown>();
    const outcome = new Map<string, CheckResult>();
    const passes = new Map<string, number>();
    const drifts = new Map<string, Drift>();
    // Replays whose call failed, so dependents are skipped instead of run with stale values.
    const failedOrdinals = new Map<number, string>();
    for (const fixture of ir.fixtures) {
      const target = replayable.get(fixture.operation_id);
      if (!target || !fixtureSucceeded(fixture)) continue;
      const { tool, action } = target;
      if (outcome.get(tool.name)?.status === "fail") {
        failedOrdinals.set(fixture.ordinal, tool.name);
        continue;
      }
      // If a value this call needs came from a failed call, it runs with the
      // recorded value instead; an error is then blamed on that dependency.
      const brokenSource = fixture.derived.find((d) => failedOrdinals.has(d.from_ordinal));
      const args: Record<string, unknown> = { ...fixture.arguments };
      for (const d of fixture.derived) {
        if (liveBodies.has(d.from_ordinal)) {
          const value = pointerGet(liveBodies.get(d.from_ordinal), d.pointer);
          if (value !== undefined) args[d.argument] = value;
        }
      }
      if (JSON.stringify(args).includes("[REDACTED]")) {
        outcome.set(tool.name, { tool: tool.name, status: "skip", detail: "sample arguments contain redacted secrets" });
        continue;
      }
      // Translate operation arguments to the tool's (group renames, action selector).
      const toolArgs: Record<string, unknown> = action.action === null ? {} : { action: action.action };
      for (const [arg, value] of Object.entries(args)) {
        // Pinned arguments are the server's to fill in; the tool does not accept them.
        if (arg in (action.pins ?? {})) continue;
        toolArgs[Object.entries(action.arg_map).find(([, v]) => v === arg)?.[0] ?? arg] = value;
      }
      const res = await client.callTool({ name: tool.name, arguments: toolArgs });
      if (res.isError && brokenSource) {
        failedOrdinals.set(fixture.ordinal, tool.name);
        if (!outcome.has(tool.name)) {
          outcome.set(tool.name, { tool: tool.name, status: "skip", detail: `depends on ${failedOrdinals.get(brokenSource.from_ordinal)}, which failed` });
        }
        continue;
      }
      if (res.isError) {
        failedOrdinals.set(fixture.ordinal, tool.name);
        const text = res.content.find((c) => c.type === "text");
        outcome.set(tool.name, { tool: tool.name, status: "fail", detail: `tool error: ${text && "text" in text ? text.text.slice(0, 300) : "unknown"}` });
        continue;
      }
      if (action.output) {
        const drift = mergeDrift(drifts.get(tool.name) ?? emptyDrift(), driftOf(action.output, res.structuredContent));
        drifts.set(tool.name, drift);
        const issues = validate(action.output, res.structuredContent);
        if (issues.length || isBreaking(drift)) {
          failedOrdinals.set(fixture.ordinal, tool.name);
          const why = isBreaking(drift) ? describeDrift(drift) : issues.slice(0, 3).join("; ");
          outcome.set(tool.name, { tool: tool.name, status: "fail", detail: `output drifted from inferred schema: ${why}`, drift });
          continue;
        }
        const structured = res.structuredContent as Record<string, unknown> | undefined;
        const body = action.output_wrapped_as ? structured?.[action.output_wrapped_as] : structured;
        liveBodies.set(fixture.ordinal, body);
        options.onSample?.(action.operation_id, body);
      }
      const count = (passes.get(tool.name) ?? 0) + 1;
      passes.set(tool.name, count);
      const drift = drifts.get(tool.name);
      outcome.set(tool.name, {
        tool: tool.name,
        status: "pass",
        detail: `${count} replay(s) matched the inferred schema${drift && hasDrift(drift) ? ` (additive drift: ${describeDrift(drift)})` : ""}`,
        ...(drift && hasDrift(drift) ? { drift } : {}),
      });
    }
    for (const tool of tools.values()) {
      const result = outcome.get(tool.name) ?? { tool: tool.name, status: "skip" as const, detail: "no successful sample to replay" };
      results.push({ ...result, operation_ids: tool.actions.map((a) => a.operation_id) });
    }
    results.sort((a, b) => a.tool.localeCompare(b.tool));
  } finally {
    await client.close();
  }
  return results;
}
