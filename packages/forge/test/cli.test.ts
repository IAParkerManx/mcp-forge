// CLI pipeline without REA: help text and sample runs come from running the
// demo CLI directly, then extract → generate → verify against a fresh data file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { argName, classifyCliEffects, extractCli, parseJsonOutput, splitArgs, type HelpCapture, type RunCapture } from "../src/extract/cli.ts";
import { draftConfig } from "../src/curate/config.ts";
import { buildManifest, generateServer } from "../src/codegen/generate.ts";
import { verifyServer } from "../src/verify/replay.ts";
import type { ForgeIR } from "../src/ir/types.ts";
// @ts-expect-error untyped template module
import { buildArgv } from "../templates/server/lib/cli-runtime.mjs";

const TASKR = fileURLToPath(new URL("../../../examples/targets/cli-demo/bin/taskr.mjs", import.meta.url));
const work = fileURLToPath(new URL("../.tmp/cli/", import.meta.url));

function run(args: string[], data: string) {
  const r = spawnSync(process.execPath, [TASKR, ...args], { env: { ...process.env, TASKR_DATA: data }, encoding: "utf8" });
  return { output: r.stdout + r.stderr, exit_code: r.status ?? -1 };
}

const SAMPLES = [
  "list --json",
  "add 'Buy milk' --tag home --tag errands --json",
  "add 'File taxes' --due 2026-04-15 --json",
  "list --status open --limit 5 --json",
  "show b2c23c08 --json",
  "done b2c23c08 --json",
  "stats --json",
  "rm b2c23c08 --force",
];

let ir: ForgeIR;
beforeAll(async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const data = join(work, "investigate.json");
  const helps: HelpCapture[] = [{ path: [], evidence_id: "ev_help_root", ...run(["--help"], data), text: run(["--help"], data).output }];
  for (const sub of ["list", "show", "add", "done", "rm", "stats"]) {
    const r = run([sub, "--help"], data);
    helps.push({ path: [sub], evidence_id: `ev_help_${sub}`, text: r.output, exit_code: r.exit_code });
  }
  const runs: RunCapture[] = SAMPLES.map((line, ordinal) => {
    const argv = splitArgs(line);
    return { ordinal, argv, evidence_id: `ev_run_${ordinal}`, ...run(argv, data) };
  });
  ir = extractCli({ command: TASKR, targetName: "taskr", reaVersion: "test", helps, runs });
});
afterAll(() => rm(work, { recursive: true, force: true }));

describe("helpers", () => {
  it("splits command lines like a shell, without expansion", () => {
    expect(splitArgs(`add 'Buy milk' --tag "a b" x\\ y $HOME`)).toEqual(["add", "Buy milk", "--tag", "a b", "x y", "$HOME"]);
    expect(() => splitArgs("add 'oops")).toThrow(/unterminated/);
  });

  it("finds JSON in terminal output", () => {
    expect(parseJsonOutput('{\r\n  "a": 1\r\n}\r\n')).toEqual({ a: 1 });
    expect(parseJsonOutput('warning: x\r\n[1,2]\r\n')).toEqual([1, 2]);
    expect(parseJsonOutput("plain")).toBeUndefined();
  });

  it("classifies effects from the verb and the description", () => {
    expect(classifyCliEffects(["remote", "prune"], "", []).effects).toBe("destructive");
    expect(classifyCliEffects(["purge-cache"], "Permanently removes the cache", []).effects).toBe("destructive");
    expect(classifyCliEffects(["ls"], "", []).effects).toBe("read");
    expect(classifyCliEffects(["frobnicate"], "", [{ long: "--force", repeatable: false, description: "" }]).effects).toBe("destructive");
    expect(classifyCliEffects(["frobnicate"], "", []).effects).toBe("unknown");
  });

  it("names short-only flags from their description", () => {
    const o = (short: string, description: string, long?: string) => ({ short, ...(long ? { long } : {}), description, repeatable: false });
    expect(argName(o("-r", "recurse into directories"))).toBe("recurse_directories");
    expect(argName(o("-f", "freshen: only changed files"))).toBe("freshen");
    expect(argName(o("-j", "junk (don't record) directory names"))).toBe("junk");
    expect(argName(o("-t", "whatever", "--tag-name"))).toBe("tag_name");
    expect(argName(o("-@", ""))).toBe("flag_64");
  });

  it("builds argv without a shell and refuses option-like values", () => {
    const binding = {
      subcommand: ["add"],
      fixed_args: ["--json"],
      options: [
        { name: "title", positional: 0, takes_value: true },
        { name: "tag", flag: "--tag", takes_value: true, repeatable: true },
        { name: "force", flag: "--force", takes_value: false },
      ],
    };
    expect(buildArgv(binding, { title: "Buy; rm -rf ~", tag: ["a", "b"], force: true })).toEqual(["add", "--json", "--tag", "a", "--tag", "b", "--force", "Buy; rm -rf ~"]);
    expect(buildArgv(binding, { title: "x", force: false })).toEqual(["add", "--json", "x"]);
    expect(() => buildArgv(binding, { title: "--delete-everything" })).toThrow(/may not start with "-"/);
    expect(() => buildArgv(binding, { title: "x", tag: ["-x"] })).toThrow(/may not start with "-"/);
  });
});

describe("extractCli on the demo CLI", () => {
  it("turns each subcommand into an operation with typed arguments", () => {
    expect(ir.operations.map((o) => [o.name, o.effects])).toEqual([
      ["taskr_add", "write"],
      ["taskr_done", "write"],
      ["taskr_list", "read"],
      ["taskr_rm", "destructive"],
      ["taskr_show", "read"],
      ["taskr_stats", "read"],
    ]);
    const list = ir.operations.find((o) => o.name === "taskr_list")!;
    expect(list.binding).toMatchObject({ kind: "cli", subcommand: ["list"], fixed_args: ["--json"], output: "json" });
    expect(list.input.properties).toMatchObject({ status: { enum: ["open", "done"] }, limit: { type: "integer", default: 20 } });
    const add = ir.operations.find((o) => o.name === "taskr_add")!;
    expect(add.input).toMatchObject({ required: ["title"], properties: { tag: { type: "array" } } });
    expect(Object.keys((add.output as { properties: object }).properties)).toEqual(["created", "due", "id", "status", "tags", "title"]);
    const removeOp = ir.operations.find((o) => o.name === "taskr_rm")!;
    expect(removeOp.binding).toMatchObject({ output: "text", fixed_args: [] });
  });

  it("maps sample argv back to arguments and links produced ids", () => {
    const add = ir.fixtures.find((f) => f.ordinal === 1)!;
    expect(add.arguments).toEqual({ title: "Buy milk", tag: ["home", "errands"] });
    expect(ir.fixtures.find((f) => f.ordinal === 3)!.arguments).toEqual({ status: "open", limit: 5 });
    expect(ir.fixtures.find((f) => f.ordinal === 5)!.derived).toEqual([{ argument: "id", from_ordinal: 4, pointer: "/id" }]);
    expect(ir.fixtures.find((f) => f.ordinal === 7)!.arguments).toEqual({ id: "b2c23c08", force: true });
  });

  it("drafts a CLI server config", () => {
    const config = draftConfig(ir);
    expect(config.server).toEqual({ name: "taskr-mcp", command_env: "TASKR_BIN", default_command: TASKR, cwd_env: "TASKR_CWD" });
    expect(buildManifest(ir, config).tools.map((t) => t.name)).toEqual(["taskr_list", "taskr_show", "taskr_stats"]);
  });
});

describe("generated CLI server", () => {
  it("replays every sample, writes included, against a fresh data file", { timeout: 60_000 }, async () => {
    const config = draftConfig(ir);
    for (const t of Object.values(config.tools)) t.enabled = true;
    const manifest = await generateServer(ir, config, join(work, "server"));
    const results = await verifyServer(ir, manifest, { serverDir: join(work, "server"), env: { TASKR_DATA: join(work, "verify.json") }, includeWrites: true });
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
    // The replay really changed the fresh data file: add → done → rm left one task.
    const left = JSON.parse(execFileSync(process.execPath, [TASKR, "list", "--json"], { env: { ...process.env, TASKR_DATA: join(work, "verify.json") }, encoding: "utf8" }));
    expect(left.tasks.map((t: { title: string }) => t.title)).toEqual(["File taxes"]);
  });
});
