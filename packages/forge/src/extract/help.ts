// Deterministic parser for conventional `--help` output: commander, argparse,
// cobra and clap styles. It reads sections (Usage, Commands, Arguments,
// Options/Flags), item rows with two-space-separated descriptions, and the
// usage line's positional placeholders. Anything it cannot read stays out of
// the result rather than being guessed.

export interface HelpOption {
  short?: string;
  long?: string;
  /** Placeholder for the value (`n`, `tag`, `string`), absent for boolean flags. */
  value?: string;
  repeatable: boolean;
  description: string;
  choices?: string[];
  default?: string;
  /** Value type implied by a typed placeholder (cobra `int`, `strings`...). */
  type?: "string" | "integer" | "number" | "boolean";
}

export interface HelpPositional {
  name: string;
  description?: string;
  required: boolean;
  variadic: boolean;
}

export interface HelpCommand {
  name: string;
  aliases: string[];
  summary: string;
}

export interface ParsedHelp {
  usage?: string;
  description?: string;
  subcommands: HelpCommand[];
  options: HelpOption[];
  positionals: HelpPositional[];
}

type SectionKind = "commands" | "options" | "arguments" | "usage" | "other";

function sectionKind(heading: string): SectionKind {
  const h = heading.toLowerCase().replace(/:$/, "").trim();
  if (/^usage$/.test(h)) return "usage";
  if (/(^|\s)(commands|subcommands)$/.test(h) || h === "available commands" || h === "management commands") return "commands";
  if (/(options|flags)$/.test(h) || h === "optional arguments") return "options";
  if (/^(arguments|args|positional arguments|positionals)$/.test(h)) return "arguments";
  return "other";
}

/** Strip ANSI escapes and carriage returns from captured terminal output. */
export function cleanTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
}

interface Item {
  term: string;
  description: string;
}

/** Split a section body into rows: `  term   description`, with indented continuations. */
function items(lines: string[]): Item[] {
  const out: Item[] = [];
  let termIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^(\s+)(\S.*?)(?:\s{2,}(\S.*))?$/.exec(line);
    if (!m) continue;
    const isContinuation = out.length > 0 && termIndent >= 0 && indent > termIndent + 1 && !/^-/.test(m[2]!);
    if (isContinuation) {
      const last = out.at(-1)!;
      last.description = `${last.description} ${line.trim()}`.trim();
      continue;
    }
    termIndent = indent;
    const term = m[2]!.trim();
    let description = (m[3] ?? "").trim();
    // Two-column layouts put a second option on the same row: "-r  recurse   -j  junk paths".
    const second = /^(.*?)\s{2,}(-[\w@][^\s]*)\s{2,}(\S.*)$/.exec(description);
    if (term.startsWith("-") && second) {
      description = second[1]!.trim();
      out.push({ term, description });
      out.push({ term: second[2]!, description: second[3]!.trim() });
      continue;
    }
    out.push({ term, description });
  }
  return out;
}

const TYPE_WORDS: Record<string, HelpOption["type"]> = {
  string: "string",
  strings: "string",
  stringarray: "string",
  int: "integer",
  int32: "integer",
  int64: "integer",
  uint: "integer",
  ints: "integer",
  float: "number",
  float32: "number",
  float64: "number",
  duration: "string",
  bool: "boolean",
};

function parseOption(item: Item): HelpOption | undefined {
  // "-t, --tag <tag...>", "-f FILE, --file FILE", "--limit=N", "-o, --output string"
  const tokens = item.term.replace(/,\s*(?=-)/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens[0]?.startsWith("-")) return undefined;
  const option: HelpOption = { repeatable: false, description: item.description };
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i]!;
    if (tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      if (eq > 0) {
        option.value ??= tok.slice(eq + 1);
        tok = tok.slice(0, eq);
      }
      const bracket = tok.indexOf("[");
      if (bracket > 0) tok = tok.slice(0, bracket); // --color[=WHEN]
      if (tok.startsWith("--")) option.long ??= tok;
      else option.short ??= tok;
    } else if (!option.value) {
      option.value = tok;
    }
  }
  if (option.value) {
    const raw = option.value;
    if (/\.\.\.|…/.test(raw)) option.repeatable = true;
    const brace = /^\{([^}]+)\}$/.exec(raw); // argparse choices
    if (brace) option.choices = brace[1]!.split(",").map((s) => s.trim());
    option.value = raw.replace(/[<>[\]{}]|\.\.\.|…/g, "").replace(/^=/, "") || "value";
    const typed = TYPE_WORDS[option.value.toLowerCase()];
    if (typed) {
      option.type = typed;
      if (/s$|array$/i.test(option.value) && option.value.toLowerCase() !== "string") option.repeatable = true;
      if (typed === "boolean") delete option.value;
    }
  }
  const d = item.description;
  const choices = /\((?:choices|one of|possible values|allowed)[:]?\s*([^)]+)\)|\[(?:possible values|choices)[:]?\s*([^\]]+)\]/i.exec(d);
  const bare = /\bone of[:]?\s*([\w-]+(?:\s*[|,]\s*[\w-]+)+)/i.exec(d);
  if ((choices || bare) && !option.choices) {
    option.choices = (choices ? (choices[1] ?? choices[2])! : bare![1]!)
      .split(/[,|]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const def = /\(default:?\s*"?([^")]+?)"?\)|\[default:?\s*"?([^"\]]+?)"?\]/i.exec(d);
  if (def) option.default = (def[1] ?? def[2])!.trim();
  if (/repeatable|multiple times|can be repeated|may be given more than once/i.test(d)) option.repeatable = true;
  if (!option.type && option.value) {
    if (option.default !== undefined && /^-?\d+$/.test(option.default)) option.type = "integer";
    else if (/^(n|num|number|count|limit|int|size|port|seconds|secs|ms|depth|max|min)$/i.test(option.value)) option.type = "integer";
  }
  if (!option.long && !option.short) return undefined;
  return option;
}

/** Placeholders in a usage line after the command path: `<title>`, `[file]`, `<files...>`. */
function usagePositionals(usage: string): HelpPositional[] {
  const out: HelpPositional[] = [];
  // Drop option groups first ("[--limit N]", "-o FILE") so their value names are not read as positionals.
  usage = usage.replace(/\[-[^\]]*\]/g, " ").replace(/(^|\s)--?[\w-]+(=\S+|\s+[A-Z][A-Z0-9_]*)?/g, " ");
  const re = /(<([^<>]+)>|\[([A-Za-z_][\w-]*(?:\.\.\.)?)\]|\b([A-Z][A-Z0-9_]{1,}(?:\.\.\.)?)\b)/g;
  for (const m of usage.matchAll(re)) {
    const raw = m[2] ?? m[3] ?? m[4];
    if (!raw) continue;
    const name = raw.replace(/\.\.\.|…/g, "").trim().replace(/\s+/g, "_");
    if (/^(options?|flags?|command|subcommand|args?)$/i.test(name)) continue;
    if (m[4] && /^(USAGE|OPTIONS|FLAGS|ARGS|COMMAND)$/.test(name)) continue;
    out.push({ name: name.toLowerCase().replace(/-/g, "_"), required: Boolean(m[2] ?? m[4]), variadic: /\.\.\.|…/.test(raw) });
  }
  return out;
}

/** Help and version switches describe the tool, not work it can do. */
function isMetaOption(opt: HelpOption): boolean {
  // `--` ends option parsing; it is not an option.
  if (opt.long === "--" || (!opt.long && opt.short === "-")) return true;
  if (/^--(help|version)$/.test(opt.long ?? "") || (!opt.long && /^-(h|V)$/.test(opt.short ?? ""))) return true;
  return !opt.value && /^(show|print|display)\b.{0,30}\b(help|usage|version)\b/i.test(opt.description);
}

export function parseHelp(raw: string): ParsedHelp {
  const text = cleanTerminal(raw);
  const lines = text.split("\n");
  const sections: { kind: SectionKind; heading: string; inline: string; body: string[] }[] = [];
  const preamble: string[] = [];
  for (const line of lines) {
    // Headings sit at column 0 and end with ":" (or carry the usage inline).
    const heading = /^([A-Za-z][A-Za-z ]{0,40}):\s*(.*)$/.exec(line);
    if (heading && !line.startsWith(" ") && sectionKind(heading[1]!) !== "other") {
      sections.push({ kind: sectionKind(heading[1]!), heading: heading[1]!, inline: heading[2]!.trim(), body: [] });
    } else if (heading && !line.startsWith(" ") && /^[A-Z ]+$/.test(heading[1]!)) {
      sections.push({ kind: "other", heading: heading[1]!, inline: heading[2]!.trim(), body: [] });
    } else if (sections.length) {
      sections.at(-1)!.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  const result: ParsedHelp = { subcommands: [], options: [], positionals: [] };
  const usageSection = sections.find((s) => s.kind === "usage");
  if (usageSection) result.usage = (usageSection.inline || usageSection.body.find((l) => l.trim())?.trim() || "").trim();
  else {
    const u = preamble.find((l) => /^\s*usage:/i.test(l));
    if (u) result.usage = u.replace(/^\s*usage:\s*/i, "").trim();
  }

  // Description: first prose paragraph after the usage line, before the next section.
  const prose = (usageSection ? usageSection.body.filter((l, i) => i > 0 || usageSection.inline) : preamble.filter((l) => !/^\s*usage:/i.test(l)))
    .filter((l) => !/^\s{0,6}-{1,2}[A-Za-z0-9@]/.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  if (prose.length) result.description = prose.join(" ").replace(/\s+/g, " ").slice(0, 500);

  for (const section of sections) {
    if (section.kind === "commands") {
      for (const item of items(section.body)) {
        const names = item.term.split(/\s+/)[0]!.split(/[,|]/).filter(Boolean);
        const [name, ...aliases] = names;
        if (!name || name.startsWith("-") || !/^[a-z0-9][\w:-]*$/i.test(name)) continue;
        result.subcommands.push({ name, aliases, summary: item.description });
      }
    } else if (section.kind === "options") {
      for (const item of items(section.body)) {
        const opt = parseOption(item);
        if (!opt) continue;
        if (isMetaOption(opt)) continue;
        result.options.push(opt);
      }
    } else if (section.kind === "arguments") {
      for (const item of items(section.body)) {
        const raw = item.term.split(/\s+/)[0]!;
        const name = raw.replace(/[<>[\]]|\.\.\.|…/g, "").toLowerCase().replace(/-/g, "_");
        if (!name || name.startsWith("-")) continue;
        result.positionals.push({ name, description: item.description, required: !/^\[/.test(raw), variadic: /\.\.\.|…/.test(raw) });
      }
    }
  }

  // Fallbacks for help without the usual headings (curl, git): option rows
  // anywhere, and command rows when the usage line takes a command.
  if (!sections.some((x) => x.kind === "options")) {
    const optionRows = lines.filter((l) => /^\s{0,6}-{1,2}[A-Za-z0-9@]/.test(l));
    for (const item of items(optionRows.map((l) => (l.startsWith(" ") ? l : ` ${l}`)))) {
      const opt = parseOption(item);
      if (!opt) continue;
      if (isMetaOption(opt)) continue;
      result.options.push(opt);
    }
  }
  if (result.subcommands.length === 0 && /<command>|\bcommand\b|\bCOMMAND\b/.test(`${result.usage ?? ""} ${lines.slice(0, 8).join(" ")}`)) {
    for (const line of lines) {
      const m = /^\s{2,8}([a-z][a-z0-9-]*)\s{2,}(\S.*)$/.exec(line);
      if (m && !result.subcommands.some((c) => c.name === m[1])) result.subcommands.push({ name: m[1]!, aliases: [], summary: m[2]!.trim() });
    }
  }

  // The usage line decides which positionals are required and adds unlisted ones.
  if (result.usage) {
    const fromUsage = usagePositionals(result.usage.replace(/^\S+(\s+[a-z][\w-]*)*/, ""));
    for (const u of fromUsage) {
      const listed = result.positionals.find((p) => p.name === u.name);
      if (listed) {
        listed.required = u.required;
        listed.variadic ||= u.variadic;
      } else if (result.subcommands.length === 0) {
        result.positionals.push(u);
      }
    }
  }
  return result;
}
