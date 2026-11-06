// --cli-help with a recorded answer: arguments described in prose that the
// deterministic parser cannot read.
import { describe, expect, it } from "vitest";
import { extractCli } from "../src/extract/cli.ts";
import { draftConfig } from "../src/curate/config.ts";
import { buildManifest } from "../src/codegen/generate.ts";
import { applyCliHelp, type CliHelpSuggestion } from "../src/llm/clihelp.ts";
// @ts-expect-error untyped template module
import { buildArgv } from "../templates/server/lib/cli-runtime.mjs";

// Written for this test: options explained in prose, which the deterministic
// parser cannot read, plus a few conventional rows it can.
const HELP = `Packr 2.1
Run packr with an archive name and the files list to add.
Use -u to update changed files only, and -L followed by a level from 0 to 9 to set compression.
The -m switch picks a mode: fast|small.
  -a   append to archive
  -r   recurse into folders
  -q   quiet
  -h2  show more help
`;

const ir = extractCli({ command: "packr", targetName: "packr", reaVersion: "test", helps: [{ path: [], evidence_id: "ev_help", text: HELP, exit_code: 0 }], runs: [] });
const answer = (): CliHelpSuggestion => ({
  operations: [
    {
      operation_id: "packr",
      arguments: [
        { name: "update", flag: "-u", positional_index: null, takes_value: false, repeatable: false, type: "boolean", choices: null, required: false, description: "Update changed files only." },
        { name: "level", flag: "-L", positional_index: null, takes_value: true, repeatable: false, type: "integer", choices: null, required: false, description: "Compression level 0-9." },
        { name: "mode", flag: "-m", positional_index: null, takes_value: true, repeatable: false, type: "string", choices: ["fast", "small", "tiny"], required: false, description: "Mode." },
        { name: "archive", flag: null, positional_index: 0, takes_value: true, repeatable: false, type: "string", choices: null, required: true, description: "Archive to write." },
        { name: "files_list", flag: null, positional_index: 1, takes_value: true, repeatable: true, type: "string", choices: null, required: false, description: "Files to add." },
        { name: "encrypt", flag: "-e", positional_index: null, takes_value: false, repeatable: false, type: "boolean", choices: null, required: false, description: "Encrypt." },
        { name: "help", flag: "--help", positional_index: null, takes_value: false, repeatable: false, type: "boolean", choices: null, required: false, description: "Help." },
        { name: "recurse", flag: "-r", positional_index: null, takes_value: false, repeatable: false, type: "boolean", choices: null, required: false, description: "Recurse." },
      ],
    },
  ],
  notes: [],
});

describe("--cli-help", () => {
  it("starts from a partial deterministic parse", () => {
    const flags = (ir.operations[0]!.binding as { options: { flag?: string }[] }).options.map((o) => o.flag);
    expect(flags).toEqual(expect.arrayContaining(["-a", "-r", "-q"]));
    expect(flags).not.toContain("-u");
    expect(flags).not.toContain("-h2");
    expect(ir.cli_help[0]!.text).toContain("Use -u to update");
  });

  it("keeps only arguments written in the help text", () => {
    const { config, report } = applyCliHelp(ir, draftConfig(ir), answer());
    const names = config.tools["packr"]!.cli_arguments!.map((a) => a.name);
    expect(names).toEqual(["update", "level", "mode", "archive", "files_list"]);
    expect(config.tools["packr"]!.cli_arguments!.find((a) => a.name === "mode")!.choices).toBeUndefined();
    expect(config.tools["packr"]!.cli_arguments!.every((a) => a.evidence[0] === "ev_help")).toBe(true);
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/-m: choices dropped/),
        expect.stringMatching(/-e: flag is not in the help text/),
        expect.stringMatching(/--help: not an allowed flag/),
      ]),
    );
    // -r was already parsed the same way: no change, no report line.
    expect(report.accepted.join(" ")).not.toContain("-r");
  });

  it("generates the corrected arguments and argv", () => {
    const { config } = applyCliHelp(ir, draftConfig(ir), answer());
    config.tools["packr"]!.enabled = true;
    const tool = buildManifest(ir, config).tools[0]!;
    expect(tool.input).toMatchObject({ required: ["archive"], properties: { level: { type: "integer" }, files_list: { type: "array" }, update: { type: "boolean" } } });
    expect(buildArgv(tool.actions[0]!.binding, { archive: "out.pk", files_list: ["a.txt", "b.txt"], level: 9, update: true, recurse_folders: true })).toEqual(["-r", "-u", "-L", "9", "out.pk", "a.txt", "b.txt"]);
  });
});
