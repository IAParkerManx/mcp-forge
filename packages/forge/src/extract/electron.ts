// Electron extractor: REA `analyze_javascript_application` Evidence (context
// bridge APIs, renderer IPC call sites, main-process handlers) plus optional
// runtime observations → IR. Each exposed member becomes an operation called
// through the renderer, so the app's own preload and main-process code run
// exactly as they do for its UI.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronBinding, EvidenceRef, Fixture, ForgeIR, JsonSchema, Operation } from "../ir/types.ts";
import type { ReaEvidence } from "../rea/client.ts";
import { inferSchema } from "../synth/schema.ts";
import { humanize, snake } from "../synth/heuristics.ts";
import { collectSecrets, redact } from "../synth/redact.ts";
import { findPointer } from "./har.ts";

interface Location {
  source: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface GraphNode {
  node_id: string;
  kind: string;
  observations: { label: string; properties: Record<string, unknown>; evidence?: { location?: { available?: boolean; value?: Location } } }[];
}

export interface BridgeMember {
  api: string;
  member: string;
  params: string[];
  rest?: string;
  channel?: string;
  ipc_mode: ElectronBinding["ipc_mode"];
  preload: string;
  member_line: number;
  handler?: { source: string; start: number; end: number };
}

/** A runtime observation of one IPC channel from REA's Electron scenario capture. */
export interface ObservedIpc {
  channel: string;
  argument_shapes: string[];
  result_shape: string | null;
  error: boolean;
}

/** A sample call made through CDP during investigation. */
export interface SampleCall {
  ordinal: number;
  api: string;
  member: string;
  args: unknown[];
  ok: boolean;
  value?: unknown;
  error?: string;
}

type Observation = GraphNode["observations"][number];

const locationOf = (o: Observation | undefined): Location | undefined => {
  const loc = o?.evidence?.location;
  return loc?.available ? loc.value : undefined;
};
const location = (n: GraphNode): Location | undefined => locationOf(n.observations[0]);

/** Parameter names from a parameter list like `(id, { force } = {}, ...rest)`. */
export function parseParams(list: string): { params: string[]; rest?: string } {
  const params: string[] = [];
  let rest: string | undefined;
  let depth = 0;
  let cur = "";
  const flush = () => {
    const raw = cur.trim();
    cur = "";
    if (!raw) return;
    if (raw.startsWith("...")) {
      rest = snake(raw.slice(3)) || "args";
      return;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(raw)?.[0];
    params.push(name ? snake(name) : `arg${params.length + 1}`);
  };
  for (const ch of list) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return { params, ...(rest ? { rest } : {}) };
}

/** Find each member's definition line and parameter list inside the exposed object literal. */
export function membersFromSource(source: string, startLine: number, endLine: number, members: string[]): Map<string, { line: number; params: string[]; rest?: string }> {
  const lines = source.split("\n");
  const out = new Map<string, { line: number; params: string[]; rest?: string }>();
  for (const member of members) {
    const name = member.replace(/[$]/g, "\\$");
    const patterns = [
      new RegExp(`(?:^|[\\s{,])["']?${name}["']?\\s*:\\s*(?:async\\s+)?(?:function\\s*[\\w$]*\\s*)?\\(([^)]*)\\)`),
      new RegExp(`(?:^|[\\s{,])["']?${name}["']?\\s*:\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>`),
      new RegExp(`(?:^|[\\s{,])(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`),
    ];
    for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
      const m = patterns.map((p) => p.exec(lines[i]!)).find(Boolean);
      if (m) {
        out.set(member, { line: i + 1, ...parseParams(m[1] ?? "") });
        break;
      }
    }
  }
  return out;
}

export async function bridgeMembers(evidence: ReaEvidence, appRoot: string): Promise<{ members: BridgeMember[]; notes: string[] }> {
  const graph = (evidence.normalized_result as { graph?: { nodes: GraphNode[] } }).graph;
  if (!graph) return { members: [], notes: ["REA returned no application graph."] };
  const notes: string[] = [];
  const handlers = graph.nodes.filter((n) => n.kind === "ipc-handler");
  // A channel node carries one observation per call site, renderer and main side alike.
  const rendererCalls = graph.nodes
    .filter((n) => n.kind === "ipc-channel")
    .flatMap((n) => n.observations.filter((o) => o.properties.side === "renderer"));
  const members: BridgeMember[] = [];

  for (const api of graph.nodes.filter((n) => n.kind === "context-bridge-api")) {
    const props = api.observations[0]!.properties as { api_key?: string | null; members?: string[]; unknown_members?: number; world?: string };
    const loc = location(api);
    if (!props.api_key) {
      notes.push("A contextBridge API with a computed key was found; it cannot be called by name.");
      continue;
    }
    if (props.world !== "main") notes.push(`contextBridge API "${props.api_key}" is exposed in the ${props.world} world; only main-world APIs are callable.`);
    if (props.unknown_members) notes.push(`contextBridge API "${props.api_key}" has ${props.unknown_members} member(s) REA could not name.`);
    if (!loc) continue;
    const text = await readFile(join(appRoot, loc.source), "utf8");
    const found = membersFromSource(text, loc.start.line, loc.end.line, props.members ?? []);
    const ordered = [...found.entries()].sort((a, b) => a[1].line - b[1].line);
    for (const [index, [member, def]] of ordered.entries()) {
      const nextLine = ordered[index + 1]?.[1].line ?? loc.end.line + 1;
      // The IPC call site inside this member's definition gives its channel.
      const call = rendererCalls.find((c) => {
        const l = locationOf(c);
        return l && l.source === loc.source && l.start.line >= def.line && l.start.line < nextLine;
      });
      const callProps = call?.properties as { channel?: string | null; mode?: string } | undefined;
      const channel = callProps?.channel ?? undefined;
      const handler = channel
        ? handlers.find((h) => h.observations[0]!.properties.channel === channel && ["handle", "on"].includes(String(h.observations[0]!.properties.operation)))
        : undefined;
      const hl = handler && (handler.observations[0]!.properties.handler_location as { start: { line: number }; end: { line: number } } | undefined);
      const handlerSource = handler && location(handler)?.source;
      members.push({
        api: props.api_key,
        member,
        ...def,
        member_line: def.line,
        preload: loc.source,
        ...(channel ? { channel } : {}),
        ipc_mode: callProps?.mode === "invoke" ? "invoke" : callProps?.mode === "send" ? "send" : "unknown",
        ...(hl && handlerSource ? { handler: { source: handlerSource, start: hl.start.line, end: hl.end.line } } : {}),
      });
    }
    for (const missing of (props.members ?? []).filter((m) => !found.has(m))) {
      notes.push(`Could not read the parameters of ${props.api_key}.${missing}; it was skipped.`);
    }
  }
  if (!members.length && !notes.length) notes.push("No contextBridge APIs found; the app may use nodeIntegration or a local server instead.");
  return { members, notes };
}

const DESTRUCTIVE = /^(delete|remove|rm|destroy|purge|clear|reset|wipe|drop|erase|uninstall|kill|quit|exit)$/;
const READ = /^(list|get|read|fetch|load|find|search|query|show|info|status|describe|count|stats|version|has|is|can|check|lookup)$/;
const WRITE = /^(create|add|new|save|set|update|edit|put|post|write|rename|move|copy|send|open|close|start|stop|toggle|enable|disable|import|export|upload|sync|apply|install|login|logout)$/;

export function classifyElectronEffects(member: string, channel?: string): { effects: Operation["effects"]; idempotent: boolean } {
  const words = [...snake(member).split("_"), ...(channel ? channel.split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()) : [])].filter(Boolean);
  if (words.some((w) => DESTRUCTIVE.test(w))) return { effects: "destructive", idempotent: false };
  const verb = words.find((w) => READ.test(w) || WRITE.test(w));
  if (verb && READ.test(verb)) return { effects: "read", idempotent: true };
  if (verb) return { effects: "write", idempotent: false };
  return { effects: "unknown", idempotent: false };
}

export interface ElectronExtractOptions {
  targetName: string;
  reaVersion: string;
  appRoot: string;
  appPath: string;
  electronExecutable?: string;
  staticEvidence: ReaEvidence;
  scenarioEvidenceId?: string;
  observed?: ObservedIpc[];
  calls?: SampleCall[];
  /** Renderer page that exposes the API, e.g. `index.html`. */
  pageHint?: string;
  secrets?: Iterable<string>;
}

export async function extractElectron(options: ElectronExtractOptions): Promise<ForgeIR> {
  const { members, notes } = await bridgeMembers(options.staticEvidence, options.appRoot);
  const secrets = new Set<string>(options.secrets ?? []);
  const operations: Operation[] = [];
  const fixtures: Fixture[] = [];
  const staticId = options.staticEvidence.evidence_id;

  for (const m of members) {
    const id = snake(`${m.api}_${m.member}`);
    const calls = (options.calls ?? []).filter((c) => c.api === m.api && c.member === m.member);
    const observed = (options.observed ?? []).filter((o) => o.channel === m.channel);
    const argNames = [...m.params, ...(m.rest ? [m.rest] : [])];

    // Argument types come from sample calls; without them any JSON value is accepted.
    const properties: Record<string, JsonSchema> = {};
    m.params.forEach((p, i) => {
      const seen = calls.filter((c) => c.ok && c.args.length > i && c.args[i] !== undefined).map((c) => c.args[i]);
      properties[p] = { ...(seen.length ? inferSchema(seen) : {}), description: `Argument ${i + 1} of ${m.api}.${m.member}(${argNames.join(", ")}).` };
    });
    if (m.rest) properties[m.rest] = { type: "array", description: `Remaining arguments of ${m.api}.${m.member}.` };
    const okCalls = calls.filter((c) => c.ok);
    const required = okCalls.length ? m.params.filter((_, i) => okCalls.every((c) => c.args.length > i && c.args[i] !== undefined)) : [];

    const values = okCalls.map((c) => c.value).filter((v) => v !== undefined);
    let output: JsonSchema | undefined;
    let wrapped: string | undefined;
    if (values.length) {
      const schema = inferSchema(values);
      if (schema.type === "object") output = schema;
      else {
        wrapped = Array.isArray(values[0]) ? "items" : "value";
        output = { type: "object", properties: { [wrapped]: schema }, required: [wrapped] };
      }
    }

    const unknowns: string[] = [];
    if (!calls.length) unknowns.push("No sample calls: argument types and the return shape are unknown.");
    else if (calls.length < 3) unknowns.push(`Only ${calls.length} sample call(s); optional arguments and fields are likely incomplete.`);
    if (!m.channel) unknowns.push("Static analysis did not pair this member with an IPC channel.");
    if (m.channel && options.observed && !observed.length) unknowns.push(`Channel ${m.channel} was not used during the observed scenario.`);

    const evidence: EvidenceRef[] = [
      { evidence_id: staticId, note: `${m.preload}:${m.member_line} ${m.api}.${m.member}${m.channel ? ` → ipc ${m.channel}` : ""}${m.handler ? ` → ${m.handler.source}:${m.handler.start}` : ""}` },
    ];
    if (options.scenarioEvidenceId && observed.length) {
      const shapes = observed.map((o) => `args [${o.argument_shapes.join(", ")}] → ${o.result_shape ?? "none"}${o.error ? " (error)" : ""}`);
      evidence.push({ evidence_id: options.scenarioEvidenceId, note: `observed ${observed.length}× at runtime: ${[...new Set(shapes)].join("; ")}` });
    }

    const { effects, idempotent } = classifyElectronEffects(m.member, m.channel);
    operations.push({
      id,
      name: id,
      title: humanize(snake(m.member)),
      description: `${humanize(snake(m.member))} (\`${m.api}.${m.member}\` in the app${m.channel ? `, IPC channel \`${m.channel}\`` : ""}).`,
      binding: {
        kind: "electron",
        api: m.api,
        member: m.member,
        params: m.params,
        ...(m.rest ? { rest: m.rest } : {}),
        ...(m.channel ? { channel: m.channel } : {}),
        ipc_mode: m.ipc_mode,
        ...(options.pageHint ? { page_url_hint: options.pageHint } : {}),
      },
      input: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
      ...(output ? { output } : {}),
      ...(wrapped ? { output_wrapped_as: wrapped } : {}),
      auth: "none",
      effects,
      idempotent,
      confidence: observed.length || okCalls.length ? "observed" : "inferred",
      sample_count: calls.length,
      evidence,
      unknowns,
    });

    for (const c of calls) {
      const args = Object.fromEntries(m.params.map((p, i) => [p, c.args[i]]).filter(([, v]) => v !== undefined));
      collectSecrets(c.value, secrets);
      fixtures.push({
        operation_id: id,
        ordinal: c.ordinal,
        arguments: args,
        exit_code: c.ok ? 0 : 1,
        derived: [],
        ...(c.value !== undefined ? { response: c.value } : {}),
        evidence: { evidence_id: staticId, note: `sample call ${m.api}.${m.member}(${JSON.stringify(c.args).slice(1, -1)}) made by forge over CDP` },
      });
    }
  }

  // Values produced by earlier calls (a created id) feed later ones during replay.
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

  operations.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ir_version: 1,
    target: { kind: "electron", name: options.targetName, app_path: options.appPath, ...(options.electronExecutable ? { electron_executable: options.electronExecutable } : {}) },
    rea_version: options.reaVersion,
    operations,
    auth: { kind: "none", credential_fields: [], evidence: [] },
    fixtures: fixtures.map((f) => ({ ...f, arguments: redact(f.arguments, secrets), ...(f.response !== undefined ? { response: redact(f.response, secrets) } : {}) })),
    sources: [],
    cli_help: [],
    notes,
  };
}
