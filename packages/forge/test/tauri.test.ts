// Tauri (read-only): reproducing read-only Docker commands from Rust source.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { extractTauri, parseCommands, readRustSources, rustString } from "../src/extract/tauri.ts";
// @ts-expect-error untyped runtime module
import { buildArgv } from "../templates/server/lib/cli-runtime.mjs";

const ROOT = fileURLToPath(new URL("./fixtures/tauri-app/", import.meta.url));

describe("tauri extraction", () => {
  it("decodes Rust string escapes", () => {
    expect(rustString("a\\x1eb\\n\\\"c\\\"\\u{1F431}")).toBe('a\x1eb\n"c"🐱');
  });

  it("reads commands and drops parameters Tauri injects", async () => {
    const commands = parseCommands(await readRustSources(ROOT));
    expect(commands.map((c) => c.name)).toEqual(["get_logs", "inspect_app", "stats_for", "app_status", "single_status", "stop_app", "logs_then_write", "computed"]);
    expect(commands[0]!.params).toEqual([{ name: "lines", type: "u32" }]);
  });

  it("reproduces only single read-only Docker calls, with reasons for the rest", async () => {
    const ir = extractTauri({ targetName: "demo", appRoot: ROOT, sources: await readRustSources(ROOT) });
    const argv = Object.fromEntries(ir.operations.map((o) => [o.name, (o.binding as { argv_template: string[] }).argv_template]));
    expect(argv).toEqual({
      demo_get_logs: ["logs", "--tail", "{lines}", "demo_app"],
      demo_inspect_app: ["inspect", "--format", "{{.Id}}\x1e{{.State.Status}}", "demo_app"],
      demo_stats_for: ["stats", "--no-stream", "--format", "{{.CPUPerc}}||{{.MemPerc}}", "{container_name}"],
      demo_single_status: ["inspect", "--format", "{{.State.Status}}", "demo_app"],
    });
    expect(ir.operations.find((o) => o.name === "demo_get_logs")!.input).toMatchObject({ required: ["lines"], properties: { lines: { type: "integer", minimum: 0 } } });
    const skipped = ir.notes.find((n) => n.startsWith("Not reproduced"))!;
    expect(skipped).toContain("app_status (read): delegates to status_by_name, which makes 2 Docker calls");
    expect(skipped).toContain("stop_app (write): `docker stop demo_app` is not a read-only Docker command");
    expect(skipped).toContain("logs_then_write (write): body also uses std::fs::write");
    expect(skipped).toContain("computed (unknown): cannot resolve Docker argument `arg`");
    expect(ir.operations.every((o) => o.effects === "read" && o.evidence[0]!.evidence_id.startsWith("source:sha256:"))).toBe(true);
  });

  it("fills argv templates and refuses option-like values", () => {
    const binding = { argv_template: ["logs", "--tail", "{lines}", "demo_app"] };
    expect(buildArgv(binding, { lines: 20 })).toEqual(["logs", "--tail", "20", "demo_app"]);
    expect(() => buildArgv(binding, {})).toThrow(/Missing argument "lines"/);
    expect(() => buildArgv({ argv_template: ["inspect", "{container_name}"] }, { container_name: "--privileged" })).toThrow(/may not start with "-"/);
  });
});
