// CLI extractor: REA process captures of `--help` output (and optional
// user-chosen sample runs) → IR. Each leaf command becomes an operation whose
// arguments map onto argv with no shell involved.
import type { CliBinding, EvidenceRef, Fixture, ForgeIR, JsonSchema, Operation } from "../ir/types.ts";
import { cleanTerminal, parseHelp, type HelpOption, type ParsedHelp } from "./help.ts";
import { findPointer } from "./har.ts";
import { inferSchema } from "../synth/schema.ts";
import { humanize, snake } from "../synth/heuristics.ts";
import { collectSecrets, redact } from "../synth/redact.ts";

export interface HelpCapture {
  path: string[];
  evidence_id: string;
  text: string;
  exit_code: number;
}

export interface RunCapture {
  ordinal: number;
  argv: string[];
  evidence_id: string;
  output: string;
  exit_code: number;
}

/** Subcommands that describe the CLI itself rather than doing work. */
export const META_COMMANDS = new Set(["help", "completion", "completions", "version", "__complete", "__completeNoDesc"]);

const READ_VERBS = /^(list|ls|show|get|view|cat|status|info|describe|inspect|search|find|query|stats|count|diff|log|logs|history|check|validate|whoami|env|config-get|print|read|tree|top|explain|lint|doctor)$/i;
const DESTRUCTIVE_VERBS = /^(rm|remove|delete|del|purge|destroy|drop|prune|clean|clear|reset|wipe|uninstall|kill|truncate|revoke|erase|nuke)$/i;
const WRITE_VERBS = /^(add|create|new|init|set|update|edit|put|post|mv|move|rename|cp|copy|done|close|open|start|stop|restart|run|exec|install|push|publish|deploy|apply|import|sync|upload|send|tag|commit|merge|write|enable|disable|login|logout)$/i;

export function classifyCliEffects(path: string[], description: string, options: HelpOption[]): { effects: Operation["effects"]; idempotent: boolean } {
  const verb = path.at(-1) ?? "";
  if (DESTRUCTIVE_VERBS.test(verb) || /\b(permanently|irreversibl|cannot be undone)\b/i.test(description)) return { effects: "destructive", idempotent: false };
  if (READ_VERBS.test(verb)) return { effects: "read", idempotent: true };
  if (WRITE_VERBS.test(verb)) return { effects: "write", idempotent: false };
  if (options.some((o) => /^--(force|yes|hard)$/.test(o.long ?? ""))) return { effects: "destructive", idempotent: false };
  return { effects: "unknown", idempotent: false };
}

/** Split a command line like a POSIX shell would for quoting only; nothing is expanded or executed. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error(`unterminated quote in: ${line}`);
  if (has || cur) out.push(cur);
  return out;
}

/** Pull the JSON document out of terminal output (PTY output may carry stray text). */
export function parseJsonOutput(output: string): unknown {
  const text = cleanTerminal(output).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

const STOPWORDS = new Set(["a", "an", "the", "in", "into", "of", "to", "only", "and", "or", "for", "from", "with", "as", "be", "is", "on", "at", "by", "this", "that", "don", "t", "do", "not"]);

/**
 * Argument name for an option: the long flag when there is one; otherwise the
 * first meaningful words of its description (`-r  recurse into directories` →
 * `recurse_directories`), since `r` tells an agent nothing.
 */
export function argName(option: HelpOption): string {
  if (option.long) return snake(option.long.replace(/^-+/, ""));
  const words = option.description
    .split(/[:;,(.]/)[0]!
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 3);
  if (words.length) return snake(words.join("_"));
  const letter = (option.short ?? "").replace(/^-+/, "");
  return /^[a-z]/i.test(letter) ? `flag_${letter.toLowerCase()}` : `flag_${[...letter].map((c) => c.charCodeAt(0)).join("_")}`;
}

/** How to ask a command for JSON: a `--json` flag or a format option that offers json. */
function jsonSwitch(help: ParsedHelp): { fixed: string[]; consumed?: HelpOption } | undefined {
  const flag = help.options.find((o) => o.long === "--json" && !o.value);
  if (flag) return { fixed: ["--json"], consumed: flag };
  const format = help.options.find((o) => /^--(output|format|out)$/.test(o.long ?? "") && o.choices?.includes("json"));
  if (format) return { fixed: [format.long!, "json"], consumed: format };
  return undefined;
}

function optionSchema(o: HelpOption): JsonSchema {
  if (!o.value) return { type: "boolean", description: o.description };
  const scalar: JsonSchema = { type: o.type && o.type !== "boolean" ? o.type : "string" };
  if (o.choices?.length) scalar.enum = o.choices;
  if (o.default !== undefined) scalar.default = scalar.type === "integer" && /^-?\d+$/.test(o.default) ? Number(o.default) : o.default;
  if (o.repeatable) return { type: "array", items: scalar, description: o.description };
  return { ...scalar, description: o.description };
}

interface Leaf {
  path: string[];
  help: ParsedHelp;
  capture: HelpCapture;
}

export interface CliExtractOptions {
  command: string;
  targetName: string;
  reaVersion: string;
  helps: HelpCapture[];
  runs: RunCapture[];
  /** Extra literals to redact (e.g. secret environment values). */
  secrets?: Iterable<string>;
}

export function extractCli(options: CliExtractOptions): ForgeIR {
  const notes: string[] = [];
  const parsed = new Map(options.helps.map((h) => [h.path.join(" "), { capture: h, help: parseHelp(h.text) }]));
  const leaves: Leaf[] = [];
  for (const { capture, help } of parsed.values()) {
    if (capture.path.some((p) => META_COMMANDS.has(p))) continue;
    const children = help.subcommands.filter((c) => !META_COMMANDS.has(c.name));
    if (children.length > 0) {
      const missing = children.filter((c) => !parsed.has([...capture.path, c.name].join(" ")));
      if (missing.length) notes.push(`No help captured for: ${missing.map((c) => [...capture.path, c.name].join(" ")).join(", ")}.`);
      continue;
    }
    if (capture.exit_code !== 0 && help.options.length === 0 && help.positionals.length === 0) {
      notes.push(`\`${[options.command, ...capture.path].join(" ")} --help\` exited ${capture.exit_code} with no readable help; skipped.`);
      continue;
    }
    leaves.push({ path: capture.path, help, capture });
  }

  const secrets = new Set<string>(options.secrets ?? []);
  const operations: Operation[] = [];
  const fixtures: Fixture[] = [];
  const runsByLeaf = new Map<string, RunCapture[]>();
  const unmatched: RunCapture[] = [];
  for (const run of options.runs) {
    const leaf = [...leaves].sort((a, b) => b.path.length - a.path.length).find((l) => l.path.every((p, i) => run.argv[i] === p));
    if (!leaf) unmatched.push(run);
    else runsByLeaf.set(leaf.path.join(" "), [...(runsByLeaf.get(leaf.path.join(" ")) ?? []), run]);
  }
  if (unmatched.length) notes.push(`Sample run(s) matched no command: ${unmatched.map((r) => r.argv.join(" ")).join("; ")}.`);

  for (const leaf of leaves) {
    const { help, path } = leaf;
    const id = snake([options.targetName, ...path].join("_"));
    const json = jsonSwitch(help);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const bindingOptions: CliBinding["options"] = [];

    help.positionals.forEach((p, index) => {
      const name = snake(p.name);
      properties[name] = p.variadic ? { type: "array", items: { type: "string" }, description: p.description ?? `Positional argument <${p.name}>.` } : { type: "string", description: p.description ?? `Positional argument <${p.name}>.` };
      if (p.required) required.push(name);
      bindingOptions.push({ name, positional: index, takes_value: true, ...(p.variadic ? { repeatable: true } : {}) });
    });
    for (const o of help.options) {
      if (o === json?.consumed) continue;
      let name = argName(o);
      if (properties[name]) {
        // e.g. -f and -F: keep both, told apart by the flag letter and its case.
        const letter = (o.short ?? o.long ?? "").replace(/^-+/, "");
        name = `${name}_${/[A-Z]/.test(letter) ? `upper_${letter.toLowerCase()}` : letter.toLowerCase()}`;
      }
      while (properties[name]) name = `${name}_2`;
      properties[name] = optionSchema(o);
      bindingOptions.push({ name, flag: o.long ?? o.short, takes_value: Boolean(o.value), ...(o.repeatable ? { repeatable: true } : {}) });
    }

    // Sample runs: arguments recovered from argv, outputs for schema inference.
    const runs = runsByLeaf.get(path.join(" ")) ?? [];
    const outputs: unknown[] = [];
    for (const run of runs) {
      const args: Record<string, unknown> = {};
      const rest = run.argv.slice(path.length);
      let positional = 0;
      let ok = true;
      for (let i = 0; i < rest.length; i++) {
        let tok = rest[i]!;
        if (json?.fixed.includes(tok)) {
          if (json.fixed.length === 2 && tok === json.fixed[0]) i++;
          continue;
        }
        if (tok.startsWith("-") && tok !== "-") {
          let inline: string | undefined;
          const eq = tok.indexOf("=");
          if (tok.startsWith("--") && eq > 0) {
            inline = tok.slice(eq + 1);
            tok = tok.slice(0, eq);
          }
          const opt = help.options.find((o) => o.long === tok || o.short === tok);
          const spec = opt && bindingOptions.find((b) => b.flag === (opt.long ?? opt.short));
          if (!opt || !spec) {
            ok = false;
            notes.push(`Sample \`${run.argv.join(" ")}\` uses ${tok}, which the help does not list; not used as a fixture.`);
            break;
          }
          if (!spec.takes_value) args[spec.name] = true;
          else {
            const raw = inline ?? rest[++i];
            const schema = properties[spec.name]!;
            const itemType = (schema.type === "array" ? (schema.items as JsonSchema).type : schema.type) as string;
            const value = itemType === "integer" || itemType === "number" ? Number(raw) : raw;
            args[spec.name] = spec.repeatable ? [...((args[spec.name] as unknown[]) ?? []), value] : value;
          }
        } else {
          const spec = bindingOptions.find((b) => b.positional === positional);
          if (!spec) {
            ok = false;
            notes.push(`Sample \`${run.argv.join(" ")}\` has more positionals than the help lists; not used as a fixture.`);
            break;
          }
          if (spec.repeatable) args[spec.name] = [...((args[spec.name] as unknown[]) ?? []), tok];
          else {
            args[spec.name] = tok;
            positional++;
          }
        }
      }
      if (!ok) continue;
      const response = json ? parseJsonOutput(run.output) : { stdout: cleanTerminal(run.output).trimEnd() };
      if (json && run.exit_code === 0 && response === undefined) notes.push(`Sample \`${run.argv.join(" ")}\` did not print JSON.`);
      if (run.exit_code === 0 && response !== undefined) outputs.push(response);
      collectSecrets(response, secrets);
      fixtures.push({
        operation_id: id,
        ordinal: run.ordinal,
        arguments: args,
        exit_code: run.exit_code,
        derived: [],
        ...(response !== undefined ? { response } : {}),
        evidence: { evidence_id: run.evidence_id, note: `sample run: ${[options.command, ...run.argv].join(" ")}` },
      });
    }

    let output: JsonSchema | undefined;
    let wrapped: string | undefined;
    if (!json) output = { type: "object", properties: { stdout: { type: "string" } }, required: ["stdout"] };
    else if (outputs.length) {
      const schema = inferSchema(outputs);
      if (schema.type === "object") output = schema;
      else {
        wrapped = Array.isArray(outputs[0]) ? "items" : "value";
        output = { type: "object", properties: { [wrapped]: schema }, required: [wrapped] };
      }
    }

    const unknowns: string[] = [];
    if (json && outputs.length === 0) unknowns.push("Never run during investigation; JSON output shape is unknown.");
    else if (json && outputs.length < 3) unknowns.push(`Only ${outputs.length} sample run(s); optional output fields are likely incomplete.`);
    if (!json) unknowns.push("No JSON output mode found; the tool returns plain text.");

    const { effects, idempotent } = classifyCliEffects(path, help.description ?? "", help.options);
    const summary = help.description ?? parsed.get(path.slice(0, -1).join(" "))?.help.subcommands.find((c) => c.name === path.at(-1))?.summary ?? "";
    const line = [options.command.split("/").at(-1), ...path].join(" ");
    const evidence: EvidenceRef[] = [{ evidence_id: leaf.capture.evidence_id, note: `${line} --help` }, ...runs.map((r) => ({ evidence_id: r.evidence_id, note: `sample run: ${r.argv.join(" ")}` }))];
    operations.push({
      id,
      name: id,
      title: humanize(id),
      description: `${summary ? `${summary.replace(/\.$/, "")}.` : humanize(path.join(" ") || options.targetName) + "."} (\`${line}\`)`,
      binding: { kind: "cli", command: options.command, subcommand: path, options: bindingOptions, fixed_args: json?.fixed ?? [], output: json ? "json" : "text" },
      input: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      ...(output ? { output } : {}),
      ...(wrapped ? { output_wrapped_as: wrapped } : {}),
      auth: "none",
      effects,
      idempotent,
      confidence: "observed",
      sample_count: runs.length,
      evidence,
      unknowns,
    });
  }

  // Values produced by earlier runs (a created id) feed later ones during replay.
  fixtures.sort((a, b) => a.ordinal - b.ordinal);
  for (const f of fixtures) {
    for (const [arg, value] of Object.entries(f.arguments)) {
      if (typeof value !== "string" || value.length < 6) continue;
      for (const prev of [...fixtures].reverse()) {
        if (prev.ordinal >= f.ordinal) continue;
        const pointer = findPointer(prev.response, value);
        if (pointer) {
          f.derived.push({ argument: arg, from_ordinal: prev.ordinal, pointer });
          break;
        }
      }
    }
  }
  const safeFixtures = fixtures.map((f) => ({ ...f, arguments: redact(f.arguments, secrets), ...(f.response !== undefined ? { response: redact(f.response, secrets) } : {}) }));

  operations.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ir_version: 1,
    target: { kind: "cli", name: options.targetName, command: options.command },
    rea_version: options.reaVersion,
    operations,
    auth: { kind: "none", credential_fields: [], evidence: [] },
    fixtures: safeFixtures,
    sources: [],
    cli_help: leaves.map((l) => ({ path: l.path, evidence_id: l.capture.evidence_id, text: redact(cleanTerminal(l.capture.text), secrets) })),
    notes,
  };
}
