// What the LLM stages are allowed to see. By default: schemas, path templates,
// effects, unknowns and Evidence ids — no observed values. Observed values
// (`examples`, redacted fixtures) are sent only with `--llm-send-samples`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bindingLine, type ForgeIR, type JsonSchema, type Operation } from "../ir/types.ts";
import { applyOverrides, type ForgeConfig } from "../curate/config.ts";
import { redact } from "../synth/redact.ts";

export interface ContextOptions {
  sendSamples: boolean;
}

/** Remove observed values from a schema. */
export function stripExamples(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripExamples);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "examples").map(([k, v]) => [k, stripExamples(v)]));
  }
  return schema;
}

export function operationDigest(raw: Operation, ir: ForgeIR, config: ForgeConfig | undefined, options: ContextOptions) {
  const tool = config?.tools[raw.id];
  // Show the model the operation as already reviewed (documented params, corrected CLI arguments).
  let op = raw;
  if (tool) {
    try {
      op = applyOverrides(raw, tool);
    } catch {
      op = raw;
    }
  }
  const binding =
    op.binding.kind === "http"
      ? { method: op.binding.method, path: op.binding.path_template }
      : op.binding.kind === "cli"
        ? { command_line: [op.binding.command.split("/").at(-1), ...op.binding.subcommand].join(" ") }
        : { electron_call: bindingLine(op.binding) };
  const schema = (s: JsonSchema | undefined) => (s === undefined ? null : options.sendSamples ? s : stripExamples(s));
  return {
    operation_id: raw.id,
    current_name: tool?.name ?? raw.name,
    enabled: tool?.enabled ?? false,
    ...binding,
    effects: op.effects,
    confidence: op.confidence,
    sample_count: op.sample_count,
    input_schema: schema(op.input),
    output_schema: schema(op.output),
    ...(op.pagination ? { pagination: op.pagination } : {}),
    unknowns: op.unknowns,
    evidence_ids: [...new Set(op.evidence.map((e) => e.evidence_id))],
    ...(options.sendSamples
      ? {
          samples: ir.fixtures
            .filter((f) => f.operation_id === op.id)
            .slice(0, 2)
            .map((f) => redact({ arguments: f.arguments, status: f.status, exit_code: f.exit_code, response: f.response })),
        }
      : {}),
  };
}

/** How the generated server handles auth, so the model does not reinvent it. */
export function sessionDigest(ir: ForgeIR) {
  return {
    kind: ir.auth.kind,
    ...(ir.auth.login_request ? { login_request: `${ir.auth.login_request.method} ${ir.auth.login_request.path}` } : {}),
    ...(ir.auth.csrf ? { csrf_header: ir.auth.csrf.header } : {}),
    handled_by_server:
      "The generated server signs in, keeps the session cookie and adds the CSRF header itself. The login request is not a tool, and tools never take credentials or tokens as arguments.",
  };
}

export interface Excerpt {
  /** Stable id the model cites: `<file>:<start>-<end>`. */
  id: string;
  evidence_id: string;
  file: string;
  start: number;
  end: number;
  text: string;
}

const CONTEXT_LINES = 6;
const CODE_SECRET = /\b(\w*(?:secret|token|api[_-]?key|password|passwd|private[_-]?key)\w*)(\s*[:=]\s*)(["'`])[^"'`\n]{6,}\3/gi;

/** Mask string literals assigned to secret-looking names before code leaves the machine. */
export function redactCode(text: string): string {
  return text.replace(CODE_SECRET, (_m, name: string, sep: string, q: string) => `${name}${sep}${q}[REDACTED]${q}`);
}
const MAX_EXCERPT_CHARS = 60_000;

/** The literal prefix of a template, before its first placeholder (`/api/notes`). */
function literalPrefix(template: string): string {
  const parts: string[] = [];
  for (const seg of template.split("/").filter(Boolean)) {
    if (seg.startsWith("{")) break;
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/**
 * Cut source excerpts around every line that mentions an observed path
 * prefix — including the shared prefix (`/api`), so endpoints that traffic
 * never exercised are in view too.
 */
export async function collectExcerpts(ir: ForgeIR): Promise<Excerpt[]> {
  const prefixes = new Set<string>();
  for (const op of ir.operations) {
    if (op.binding.kind === "electron") {
      // Electron: the bridge member, its IPC channel, and the handler side.
      prefixes.add(op.binding.member);
      if (op.binding.channel) prefixes.add(op.binding.channel);
      continue;
    }
    if (op.binding.kind !== "http") continue;
    const prefix = literalPrefix(op.binding.path_template);
    prefixes.add(prefix);
    const first = prefix.split("/").filter(Boolean)[0];
    if (first) prefixes.add(`/${first}/`);
  }
  const needles = [...prefixes].filter((p) => p.length > 1);
  const excerpts: Excerpt[] = [];
  let budget = MAX_EXCERPT_CHARS;
  for (const source of ir.sources) {
    for (const file of source.files) {
      const lines = (await readFile(join(source.root, file.path), "utf8")).split("\n");
      const hits = lines.flatMap((line, i) => (needles.some((n) => line.includes(n)) ? [i] : []));
      // Merge overlapping windows.
      const windows: [number, number][] = [];
      for (const i of hits) {
        const start = Math.max(0, i - CONTEXT_LINES);
        const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
        const last = windows.at(-1);
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else windows.push([start, end]);
      }
      for (const [start, end] of windows) {
        const text = redactCode(
          lines
            .slice(start, end + 1)
            .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
            .join("\n"),
        );
        if (text.length > budget) return excerpts;
        budget -= text.length;
        excerpts.push({ id: `${file.path}:${start + 1}-${end + 1}`, evidence_id: source.evidence_id, file: file.path, start: start + 1, end: end + 1, text });
      }
    }
  }
  return excerpts;
}
