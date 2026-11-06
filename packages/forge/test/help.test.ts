// Help-text parsing across common CLI frameworks. The fixtures are written for
// these tests in each framework's style; they are not copied from real tools.
import { describe, expect, it } from "vitest";
import { parseHelp } from "../src/extract/help.ts";

const commander = `Usage: taskr add [options] <title>

Add a task.

Arguments:
  title               Task title

Options:
  -t, --tag <tag...>  Tags for the task (repeatable)
  -d, --due <date>    Due date, YYYY-MM-DD
  -n, --limit <n>     Maximum number (default: 20)
  -s, --status <s>    Status (choices: open, done)
      --json          Print JSON
  -h, --help          Show help
`;

const argparse = `usage: fetcher [-h] [--retries N] [--mode {fast,safe}] [-o FILE] url [extra ...]

Download one URL.

positional arguments:
  url                   address to fetch
  extra                 extra headers

options:
  -h, --help            show this help message and exit
  --retries N           how many times to retry
  --mode {fast,safe}    transfer mode
  -o FILE, --output FILE
                        write the body to FILE
`;

const cobra = `Manage widgets in a workspace.

Usage:
  wctl [command]

Available Commands:
  completion  Generate the autocompletion script
  create      Create a widget
  get         Get widgets
  help        Help about any command

Flags:
  -h, --help               help for wctl
      --workspace string   workspace to use (default "main")

Use "wctl [command] --help" for more information about a command.
`;

const cobraLeaf = `Get widgets

Usage:
  wctl get [name] [flags]

Flags:
      --all-namespaces      include every namespace
  -l, --labels strings      label selectors
  -o, --output string       output format: one of json|yaml|table (default "table")
      --limit int           maximum results (default 50)
`;

const clap = `Bundle files into an archive

Usage: pack [OPTIONS] <OUTPUT> [INPUTS]...

Arguments:
  <OUTPUT>     Archive to write
  [INPUTS]...  Files to add

Options:
  -l, --level <LEVEL>  Compression level [default: 6]
      --format <FMT>   Archive format [possible values: zip, tar]
  -v, --verbose...     More output
  -h, --help           Print help
  -V, --version        Print version
`;

describe("parseHelp", () => {
  it("reads commander-style help", () => {
    const h = parseHelp(commander);
    expect(h.usage).toBe("taskr add [options] <title>");
    expect(h.description).toBe("Add a task.");
    expect(h.positionals).toEqual([{ name: "title", description: "Task title", required: true, variadic: false }]);
    expect(h.options.map((o) => o.long)).toEqual(["--tag", "--due", "--limit", "--status", "--json"]);
    expect(h.options[0]).toMatchObject({ short: "-t", value: "tag", repeatable: true });
    expect(h.options[2]).toMatchObject({ default: "20", type: "integer" });
    expect(h.options[3]!.choices).toEqual(["open", "done"]);
    expect(h.options[4]).toMatchObject({ long: "--json", repeatable: false });
    expect(h.options[4]!.value).toBeUndefined();
  });

  it("reads argparse-style help with continuation lines and brace choices", () => {
    const h = parseHelp(argparse);
    expect(h.positionals.map((p) => [p.name, p.required])).toEqual([
      ["url", true],
      ["extra", true],
    ]);
    expect(h.options.find((o) => o.long === "--mode")!.choices).toEqual(["fast", "safe"]);
    expect(h.options.find((o) => o.long === "--output")).toMatchObject({ short: "-o", value: "FILE", description: "write the body to FILE" });
    expect(h.options.find((o) => o.long === "--retries")!.type).toBe("integer");
  });

  it("reads cobra command lists and typed flags", () => {
    const root = parseHelp(cobra);
    expect(root.subcommands.map((c) => c.name)).toEqual(["completion", "create", "get", "help"]);
    expect(root.options).toEqual([expect.objectContaining({ long: "--workspace", value: "string", type: "string", default: "main" })]);
    const leaf = parseHelp(cobraLeaf);
    expect(leaf.positionals).toEqual([{ name: "name", required: false, variadic: false }]);
    expect(leaf.options.find((o) => o.long === "--labels")).toMatchObject({ type: "string", repeatable: true });
    expect(leaf.options.find((o) => o.long === "--limit")).toMatchObject({ type: "integer", default: "50" });
    expect(leaf.options.find((o) => o.long === "--output")!.choices).toEqual(["json", "yaml", "table"]);
    expect(leaf.options.find((o) => o.long === "--all-namespaces")!.value).toBeUndefined();
  });

  it("reads clap-style help", () => {
    const h = parseHelp(clap);
    expect(h.positionals).toEqual([
      { name: "output", description: "Archive to write", required: true, variadic: false },
      { name: "inputs", description: "Files to add", required: false, variadic: true },
    ]);
    expect(h.options.find((o) => o.long === "--level")).toMatchObject({ default: "6", type: "integer" });
    expect(h.options.find((o) => o.long === "--format")!.choices).toEqual(["zip", "tar"]);
    expect(h.options.map((o) => o.long)).not.toContain("--version");
  });

  it("strips terminal escapes and CRLF from captured output", () => {
    const h = parseHelp("\x1b[1mUsage:\x1b[0m tool <file>\r\n\r\nOptions:\r\n  --dry-run  Do nothing\r\n");
    expect(h.positionals[0]!.name).toBe("file");
    expect(h.options[0]!.long).toBe("--dry-run");
  });

  it("splits two-column option rows", () => {
    const h = parseHelp("Usage: packr [options] archive\n\nOptions:\n  -a   append to archive          -u   update changed files only\n  -r   recurse into folders\n");
    expect(h.options.map((o) => [o.short, o.description])).toEqual([
      ["-a", "append to archive"],
      ["-u", "update changed files only"],
      ["-r", "recurse into folders"],
    ]);
  });

  it("reads placeholders with spaces and ignores the -- terminator", () => {
    const h = parseHelp("Usage:\tjq [options] <jq filter> [file...]\n\nCommand options:\n  -c, --compact-output  compact\n  --                    terminates argument processing;\n");
    expect(h.positionals).toEqual([
      { name: "jq_filter", required: true, variadic: false },
      { name: "file", required: false, variadic: true },
    ]);
    expect(h.options.map((o) => o.long)).toEqual(["--compact-output"]);
  });
});
