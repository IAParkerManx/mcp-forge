// IR + config → a standalone MCP server directory. Codegen is deterministic:
// the same IR and config always produce byte-identical output.
import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { bindingLine, type ForgeIR, type JsonSchema, type Operation } from "../ir/types.ts";
import { resolveConfig, type ForgeConfig, type Guard, type Pin, type ResolvedGroup, type ResolvedTool, type ToolConfig } from "../curate/config.ts";

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/server/", import.meta.url));
export const SDK_VERSION = "2.3.1";

function shortId(id: string): string {
  return id.length > 15 ? `${id.slice(0, 15)}…` : id;
}

function evidenceLine(op: Operation): string {
  const ev = op.evidence
    .map((e) => {
      // REA Evidence ids start with ev_; source-derived evidence names the file hash instead.
      const label = e.evidence_id.startsWith("source:") ? `source ${e.evidence_id.slice("source:".length, "source:sha256:".length + 12)}…` : `REA ${shortId(e.evidence_id)}`;
      return `${label}${e.records?.length ? ` records ${e.records.join(",")}` : ""}${e.note ? ` (${e.note})` : ""}`;
    })
    .join("; ");
  return `Evidence: ${op.confidence}, ${op.sample_count} sample(s) — ${ev}.`;
}

function describe(op: Operation): string {
  const parts = [op.description];
  if (op.pagination) {
    parts.push(`Paginated: pass the response's \`${op.pagination.response_field}\` back as \`${op.pagination.request_param}\` to get the next page.`);
  }
  if (op.effects === "destructive") parts.push("This permanently changes data on the target.");
  parts.push(evidenceLine(op));
  if (op.unknowns.length) parts.push(`Unknowns: ${op.unknowns.join(" ")}`);
  return parts.join("\n\n");
}

function annotate(ops: Operation[]) {
  return {
    readOnlyHint: ops.every((o) => o.effects === "read"),
    destructiveHint: ops.some((o) => o.effects === "destructive" || o.effects === "unknown"),
    idempotentHint: ops.every((o) => o.idempotent),
    openWorldHint: true,
  };
}

function effectsOf(ops: Operation[]): Operation["effects"] {
  for (const level of ["destructive", "unknown", "write"] as const) if (ops.some((o) => o.effects === level)) return level;
  return "read";
}

// Output fields that carry session secrets. The generated server manages these
// itself, so agents never see them. Pagination cursors are not secrets.
const SECRET_OUTPUT = /csrf|xsrf|^pass(word|wd)?$|secret|api[_-]?key|session|(access|refresh|id|auth|bearer)_?token$/i;

/**
 * Remove secret fields from an operation's output schema. Returns the cleaned
 * operation and the dotted paths (`items[].session_id`) the runtime must strip
 * from live responses.
 */
export function stripSecretOutputs(op: Operation): { op: Operation; omit: string[] } {
  if (!op.output) return { op, omit: [] };
  const keep = op.pagination?.response_field;
  const omit: string[] = [];
  const walk = (schema: JsonSchema, path: string): JsonSchema => {
    if (schema.type === "array" && schema.items) return { ...schema, items: walk(schema.items as JsonSchema, `${path}[]`) };
    if (!schema.properties) return schema;
    const properties: Record<string, JsonSchema> = {};
    for (const [name, child] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
      const here = path ? `${path}.${name}` : name;
      if (SECRET_OUTPUT.test(name) && name !== keep) {
        omit.push(here);
        continue;
      }
      properties[name] = walk(child, here);
    }
    const required = ((schema.required ?? []) as string[]).filter((r) => r in properties);
    const { required: _drop, ...rest } = schema;
    return { ...rest, properties, ...(required.length ? { required } : {}) };
  };
  const output = walk(op.output, "");
  return omit.length ? { op: { ...op, output }, omit } : { op, omit };
}

/** How one tool call maps onto one operation. */
function actionSpec(op: Operation, action: string | null, argMap: Record<string, string> = {}, omit: string[] = [], tool?: ToolConfig) {
  const pins: Record<string, Pin> = tool?.pinned ?? {};
  const guards: Guard[] = tool?.guard ?? [];
  return {
    action,
    operation_id: op.id,
    binding: op.binding,
    auth: op.auth,
    effects: op.effects,
    required: ((op.input.required ?? []) as string[]).filter((r) => !(r in pins)).map((r) => Object.entries(argMap).find(([, v]) => v === r)?.[0] ?? r),
    /** tool argument → operation argument, when a group had to rename one. */
    arg_map: argMap,
    ...(op.output ? { output: structuredClone(op.output) } : {}),
    ...(op.output_wrapped_as ? { output_wrapped_as: op.output_wrapped_as } : {}),
    /** Secret fields removed from responses before the agent sees them. */
    omit_fields: omit,
    /** Arguments the server fills in, and checks made before the call. */
    pins,
    guards,
  };
}

/** Tell the agent which values the server sets itself, and which checks it makes. */
function safeguardsNote(cfg: ToolConfig | undefined): string {
  const parts: string[] = [];
  const pins = Object.entries(cfg?.pinned ?? {}).map(([name, pin]) =>
    "value" in pin ? `${name} = ${JSON.stringify(pin.value)}` : "from" in pin ? `${name} (from ${pin.from})` : `${name} (built from other arguments)`,
  );
  if (pins.length) parts.push(`Set by the server, not by you: ${pins.join("; ")}.`);
  for (const g of cfg?.guard ?? []) parts.push(`Refused unless ${g.message ?? Object.entries(g.require).map(([p, v]) => `${p} is ${JSON.stringify(v)}`).join(" and ")} (checked with ${g.operation}).`);
  return parts.join(" ");
}

function singleTool(tool: ResolvedTool) {
  const { op, omit } = stripSecretOutputs(tool.operation);
  const note = safeguardsNote(tool.config);
  return {
    name: op.name,
    title: op.title ?? op.name,
    description: note ? `${describe(op)}\n\n${note}` : describe(op),
    input: structuredClone(op.input),
    ...(op.output ? { output: structuredClone(op.output) } : {}),
    annotations: annotate([op]),
    meta: { "mcp-forge/effects": op.effects, "mcp-forge/confidence": op.confidence, "mcp-forge/evidence": op.evidence },
    actions: [actionSpec(op, null, {}, omit, tool.config)],
  };
}

const stripDescription = (schema: JsonSchema) => JSON.stringify({ ...schema, description: undefined });

/** Several operations behind one tool: an `action` enum plus the union of their arguments. */
function groupTool(group: ResolvedGroup) {
  const properties: Record<string, JsonSchema> = {};
  const usedBy = new Map<string, string[]>();
  const actions = group.actions.map(({ action, operation: raw, config }) => {
    const { op: operation, omit } = stripSecretOutputs(raw);
    const argMap: Record<string, string> = {};
    for (const [arg, schema] of Object.entries((operation.input.properties ?? {}) as Record<string, JsonSchema>)) {
      let name = arg;
      if (properties[name] && stripDescription(properties[name]!) !== stripDescription(schema)) name = `${action}_${arg}`;
      if (!properties[name]) properties[name] = structuredClone(schema);
      usedBy.set(name, [...(usedBy.get(name) ?? []), action]);
      if (name !== arg) argMap[name] = arg;
    }
    return actionSpec(operation, action, argMap, omit, config);
  });
  for (const [name, list] of usedBy) {
    const base = properties[name]!.description ? `${properties[name]!.description} ` : "";
    properties[name]!.description = `${base}Used by: ${list.join(", ")}.`;
  }
  const ops = group.actions.map((a) => a.operation);
  const lines = group.actions.map(({ action, operation, config }) => {
    const spec = actions.find((a) => a.action === action)!;
    const note = safeguardsNote(config);
    const args = Object.entries((operation.input.properties ?? {}) as object).map(([arg]) => Object.entries(spec.arg_map).find(([, v]) => v === arg)?.[0] ?? arg);
    return `- \`${action}\`: ${operation.description}${args.length ? ` Arguments: ${args.join(", ")}.` : ""} (${operation.effects})${note ? ` ${note}` : ""}`;
  });
  return {
    name: group.name,
    title: group.name,
    description: [group.config.description, lines.join("\n"), ...group.actions.map(({ action, operation }) => `${action}: ${evidenceLine(operation)}`)].join("\n\n"),
    input: {
      type: "object",
      properties: { action: { type: "string", enum: group.actions.map((a) => a.action), description: "Which operation to run." }, ...properties },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: annotate(ops),
    meta: { "mcp-forge/effects": effectsOf(ops), "mcp-forge/confidence": ops.every((o) => o.confidence === "observed") ? "observed" : "inferred", "mcp-forge/evidence": ops.flatMap((o) => o.evidence) },
    actions,
  };
}

/**
 * Descriptions name other tools ("use get_note next"). When an operation was
 * folded into a group, its standalone tool no longer exists, so point at the
 * group action instead.
 */
function rewriteGroupedNames<T extends { description: string }>(tools: T[], groups: ResolvedGroup[]): T[] {
  const renames = groups.flatMap((g) => g.actions.map(({ action, operation }) => [operation.name, `${g.name} (action "${action}")`] as const));
  if (renames.length === 0) return tools;
  const pattern = new RegExp(`(?<![\\w-])(${renames.map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "g");
  const to = new Map(renames);
  return tools.map((t) => ({ ...t, description: t.description.replace(pattern, (m) => to.get(m) ?? m) }));
}

/**
 * Operations that pins and guards call. They run on the server's side only,
 * so they must be read-only; they need not be enabled as tools.
 */
function supportOperations(resolved: ReturnType<typeof resolveConfig>) {
  const configs = [...resolved.tools.map((t) => [t.operation.name, t.config] as const), ...resolved.groups.flatMap((g) => g.actions.map((a) => [`${g.name}/${a.action}`, a.config] as const))];
  const support: Record<string, ReturnType<typeof actionSpec>> = {};
  for (const [toolName, cfg] of configs) {
    const refs = [
      ...Object.entries(cfg.pinned ?? {}).flatMap(([arg, pin]) => ("from" in pin ? [[pin.from, `pinned ${arg}`] as const] : [])),
      ...(cfg.guard ?? []).map((g) => [g.operation, "guard"] as const),
    ];
    for (const [id, use] of refs) {
      const op = resolved.operations.get(id);
      if (!op) throw new Error(`forge.config.yaml: ${toolName} ${use} uses unknown operation "${id}"`);
      if (op.effects !== "read") throw new Error(`forge.config.yaml: ${toolName} ${use} uses ${id}, which is not read-only (${op.effects})`);
      support[id] = actionSpec(op, null);
    }
  }
  return support;
}

export function buildManifest(ir: ForgeIR, config: ForgeConfig) {
  const resolved = resolveConfig(ir, config);
  const support = supportOperations(resolved);
  const tools = rewriteGroupedNames([...resolved.groups.map(groupTool), ...resolved.tools.map(singleTool)], resolved.groups).sort((a, b) => a.name.localeCompare(b.name));
  return {
    generated_by: "mcp-forge",
    rea_version: ir.rea_version,
    server: {
      name: config.server.name,
      version: "0.1.0",
      base_url_env: config.server.base_url_env,
      default_base_url: config.server.default_base_url,
      command_env: config.server.command_env,
      default_command: config.server.default_command,
      cwd_env: config.server.cwd_env,
      cdp_url_env: config.server.cdp_url_env,
      electron_env: config.server.electron_env,
      default_electron: config.server.default_electron,
      app_env: config.server.app_env,
      default_app: config.server.default_app,
    },
    auth: {
      kind: config.auth.kind,
      token_env: config.auth.token_env,
      token_file_env: config.auth.token_file_env,
      token_header: config.auth.token_header,
      token_scheme: config.auth.token_scheme,
      cookie_env: config.auth.cookie_env,
      login_credentials_env: config.auth.login_credentials_env,
      login_request: ir.auth.login_request,
      csrf: ir.auth.csrf,
    },
    tools,
    support,
    quarantined: resolved.quarantined,
  };
}

export type Manifest = ReturnType<typeof buildManifest>;

function requestLine(binding: Manifest["tools"][number]["actions"][number]["binding"]): string {
  return `\`${bindingLine(binding)}\``;
}

function readme(manifest: Manifest, ir: ForgeIR): string {
  const env: string[] = [];
  if (manifest.server.base_url_env) env.push(`- \`${manifest.server.base_url_env}\` — target base URL (default \`${manifest.server.default_base_url ?? "none"}\`)`);
  if (manifest.server.command_env) env.push(`- \`${manifest.server.command_env}\` — the executable to run (default \`${manifest.server.default_command ?? "none"}\`)`);
  if (manifest.server.cwd_env) env.push(`- \`${manifest.server.cwd_env}\` — working directory for commands (default: the server's)`);
  if (manifest.server.cdp_url_env) env.push(`- \`${manifest.server.cdp_url_env}\` — attach to an app you started with \`--remote-debugging-port=<port>\` (e.g. \`http://127.0.0.1:9333\`), or…`);
  if (manifest.server.electron_env) env.push(`- \`${manifest.server.electron_env}\` — Electron executable to launch the app with a private debugging port (default \`${manifest.server.default_electron ?? "none"}\`)`);
  if (manifest.server.app_env) env.push(`- \`${manifest.server.app_env}\` — app path passed to that executable (default \`${manifest.server.default_app ?? "none"}\`)`);
  if (manifest.auth.kind === "token") {
    env.push(`- \`${manifest.auth.token_env}\` — your API token, sent as \`${manifest.auth.token_header}: ${manifest.auth.token_scheme ? `${manifest.auth.token_scheme} ` : ""}<token>\`, or…`);
    env.push(`- \`${manifest.auth.token_file_env}\` — the path of a file containing it (keeps the token out of your MCP client config)`);
  }
  if (manifest.auth.cookie_env) env.push(`- \`${manifest.auth.cookie_env}\` — a Cookie header from your own signed-in session, or…`);
  for (const [field, name] of Object.entries(manifest.auth.login_credentials_env ?? {})) env.push(`- \`${name}\` — login \`${field}\` for your own account`);
  const rows = manifest.tools.map((t) => {
    const requests = t.actions.map((a) => `${a.action ? `${a.action}: ` : ""}${requestLine(a.binding)}`).join("<br>");
    return `| \`${t.name}\` | ${requests} | ${t.meta["mcp-forge/effects"]} | ${t.meta["mcp-forge/confidence"]} |`;
  });
  return `# ${manifest.server.name}

Generated by [mcp-forge](https://github.com/) from REA ${ir.rea_version} evidence. Regenerate instead of editing:
change \`forge.config.yaml\` and run \`mcp-forge generate\`.

Use this only with accounts and services you are authorized to access, and within their terms.

## Run

\`\`\`bash
npm install
node server.mjs
\`\`\`

Add to Claude Code:

\`\`\`bash
claude mcp add ${manifest.server.name} -- node ${"$PWD"}/server.mjs
\`\`\`

## Environment

${env.join("\n")}

## Tools

| Tool | Runs | Effects | Confidence |
|---|---|---|---|
${rows.join("\n")}
${
  manifest.quarantined.length
    ? `
## Quarantined

These tools were left out because \`mcp-forge verify\` found the live target no longer matches. Re-investigate, or clear \`quarantined\` in forge.config.yaml once fixed.

${manifest.quarantined.map((q) => `- \`${q.name}\` (since ${q.since}): ${q.reason}`).join("\n")}
`
    : ""
}`;
}

export async function generateServer(ir: ForgeIR, config: ForgeConfig, outDir: string): Promise<Manifest> {
  const manifest = buildManifest(ir, config);
  await mkdir(outDir, { recursive: true });
  await cp(TEMPLATE_DIR, outDir, { recursive: true });
  await writeFile(join(outDir, "tools.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(
    join(outDir, "package.json"),
    JSON.stringify(
      {
        name: manifest.server.name,
        version: "0.1.0",
        private: true,
        type: "module",
        description: `MCP server for ${ir.target.name}, generated by mcp-forge`,
        bin: { [manifest.server.name]: "server.mjs" },
        engines: { node: ">=22.19" },
        dependencies: { "@modelcontextprotocol/server": SDK_VERSION },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(outDir, "README.md"), readme(manifest, ir));
  return manifest;
}
