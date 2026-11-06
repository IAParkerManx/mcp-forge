// forge.config.yaml: the human review step between investigation and codegen.
// `mcp-forge plan` drafts it from the IR; the user (and, optionally, the LLM
// stages as reviewable suggestions) edits it; `mcp-forge generate` applies it.
// Write and destructive tools start disabled.
import { z } from "zod";
import YAML from "yaml";
import { bindingLine, type Effects, type ForgeIR, type HttpParam, type JsonSchema, type Operation } from "../ir/types.ts";
import { Effects as EffectsSchema } from "../ir/types.ts";

const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "tool names are lower snake_case");

/** Documentation (and, for inputs, an enum) sourced from code or curation. */
export const FieldOverride = z.object({
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  format: z.string().optional(),
  /** Where this came from: `ev_…` ids, optionally `#file:lines`. */
  evidence: z.array(z.string()).min(1),
});
export type FieldOverride = z.infer<typeof FieldOverride>;

/** A CLI argument the help parser missed or misread, read from the captured help. */
export const CliArgumentOverride = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  flag: z.string().optional(),
  positional: z.number().int().min(0).optional(),
  takes_value: z.boolean(),
  repeatable: z.boolean().default(false),
  type: z.enum(["string", "integer", "number", "boolean"]),
  choices: z.array(z.string()).optional(),
  required: z.boolean().default(false),
  description: z.string().optional(),
  evidence: z.array(z.string()).min(1),
});
export type CliArgumentOverride = z.infer<typeof CliArgumentOverride>;

export const Quarantine = z.object({ reason: z.string(), since: z.string() });

/**
 * A pinned argument: the agent cannot set it; the server fills it in.
 * - `value`: always this value (e.g. status: DRAFT)
 * - `from` + `pointer`: read from another, read-only operation's response, cached
 *   for the server's lifetime (e.g. worker_id from a "who am I" call)
 * - `template`: built from other arguments, e.g. "forge-{worker_id}-{start_date}"
 * A pin whose name is not one of the operation's arguments is computed only, for
 * use in templates and guards, and is not sent.
 */
export const Pin = z.union([
  z.object({ from: z.string(), pointer: z.string(), args: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ template: z.string() }).strict(),
  z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
]);
export type Pin = z.infer<typeof Pin>;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A check made before the call: run a read-only operation (args may use
 * {templates}) and require JSON pointers in its response to equal values
 * (templates allowed; a list means "any of these"). Otherwise the call is refused.
 */
export const Guard = z.object({
  operation: z.string(),
  args: z.record(z.string(), z.string()).default({}),
  require: z.record(z.string(), z.union([Scalar, z.array(Scalar)])),
  message: z.string().optional(),
});
export type Guard = z.infer<typeof Guard>;

export const ToolConfig = z.object({
  enabled: z.boolean(),
  /** Set by `mcp-forge verify --quarantine` when the live target no longer matches; generate leaves the tool out. */
  quarantined: Quarantine.optional(),
  name: ToolName,
  description: z.string().optional(),
  effects: EffectsSchema.optional(),
  /** Input argument overrides keyed by argument name. */
  params: z.record(z.string(), FieldOverride).optional(),
  /** CLI targets: arguments added or corrected from the help text. */
  cli_arguments: z.array(CliArgumentOverride).optional(),
  /** Output field documentation keyed by dotted path (`items.color`). */
  outputs: z.record(z.string(), FieldOverride.omit({ enum: true, format: true }).extend({ known_values: z.array(z.string()).optional() })).optional(),
  /** Arguments the server fills in; they are removed from the tool's inputs. */
  pinned: z.record(z.string(), Pin).optional(),
  /** Checks that must pass before the call is made. */
  guard: z.array(Guard).optional(),
});
export type ToolConfig = z.infer<typeof ToolConfig>;

/** Several operations exposed as one task-shaped tool with an `action` argument. */
export const GroupConfig = z.object({
  enabled: z.boolean(),
  description: z.string(),
  /** action name → operation id. Members whose own tool entry is disabled are left out. */
  actions: z.record(ToolName, z.string()),
  evidence: z.array(z.string()).min(1),
});
export type GroupConfig = z.infer<typeof GroupConfig>;

/** An endpoint seen only in code, never in traffic. Always starts disabled. */
export const InferredOperationConfig = z.object({
  enabled: z.boolean(),
  name: ToolName,
  description: z.string(),
  method: z.string(),
  path_template: z.string(),
  effects: EffectsSchema,
  params: z.array(
    z.object({
      name: z.string(),
      in: z.enum(["path", "query", "body"]),
      type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
      required: z.boolean(),
      description: z.string().optional(),
    }),
  ),
  evidence: z.array(z.string()).min(1),
});
export type InferredOperationConfig = z.infer<typeof InferredOperationConfig>;

export const ForgeConfig = z.object({
  config_version: z.literal(1),
  server: z.object({
    name: z.string(),
    /** Web targets: environment variable that overrides the target base URL at runtime. */
    base_url_env: z.string().optional(),
    default_base_url: z.string().optional(),
    /** CLI targets: environment variable that overrides the executable, and the default. */
    command_env: z.string().optional(),
    default_command: z.string().optional(),
    /** CLI targets: environment variable for the working directory commands run in. */
    cwd_env: z.string().optional(),
    /** Electron targets: attach to a running app's loopback debugging endpoint... */
    cdp_url_env: z.string().optional(),
    /** ...or launch it: the Electron executable and the app path. */
    electron_env: z.string().optional(),
    default_electron: z.string().optional(),
    app_env: z.string().optional(),
    default_app: z.string().optional(),
  }),
  auth: z.object({
    kind: z.enum(["none", "cookie-session", "token"]),
    /** Token auth: variable holding the token, or a variable naming a file that contains it. */
    token_env: z.string().optional(),
    token_file_env: z.string().optional(),
    token_header: z.string().optional(),
    /** "Bearer" by default; "" sends the token as the whole header value (API-key headers). */
    token_scheme: z.string().optional(),
    /** Raw Cookie header pasted from the user's own logged-in browser session. */
    cookie_env: z.string().optional(),
    /** Login replay with credentials from the environment, keyed by body field. */
    login_credentials_env: z.record(z.string(), z.string()).optional(),
  }),
  tools: z.record(z.string(), ToolConfig),
  groups: z.record(ToolName, GroupConfig).optional(),
  inferred_operations: z.record(z.string(), InferredOperationConfig).optional(),
});
export type ForgeConfig = z.infer<typeof ForgeConfig>;

function envPrefix(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();
}

export function draftConfig(ir: ForgeIR): ForgeConfig {
  const prefix = envPrefix(ir.target.name);
  const tools: Record<string, ToolConfig> = {};
  for (const op of ir.operations) {
    tools[op.id] = { enabled: op.effects === "read", name: op.name, description: op.description };
  }
  const name = `${ir.target.name}-mcp`;
  const server =
    ir.target.kind === "cli" || ir.target.kind === "tauri"
      ? { name, command_env: `${prefix}_BIN`, ...(ir.target.command ? { default_command: ir.target.command } : {}), cwd_env: `${prefix}_CWD` }
      : ir.target.kind === "electron"
        ? {
            name,
            cdp_url_env: `${prefix}_CDP_URL`,
            electron_env: `${prefix}_ELECTRON`,
            ...(ir.target.electron_executable ? { default_electron: ir.target.electron_executable } : {}),
            app_env: `${prefix}_APP`,
            ...(ir.target.app_path ? { default_app: ir.target.app_path } : {}),
          }
        : { name, base_url_env: `${prefix}_BASE_URL`, ...(ir.target.base_url ? { default_base_url: ir.target.base_url } : {}) };
  return {
    config_version: 1,
    server,
    auth: {
      kind: ir.auth.kind,
      ...(ir.auth.kind === "token" && ir.auth.token
        ? {
            token_env: ir.auth.token.env_hint ?? `${prefix}_TOKEN`,
            token_file_env: `${prefix}_TOKEN_FILE`,
            token_header: ir.auth.token.header,
            token_scheme: ir.auth.token.scheme,
          }
        : {}),
      ...(ir.auth.kind === "cookie-session" ? { cookie_env: `${prefix}_COOKIE` } : {}),
      ...(ir.auth.credential_fields.length
        ? { login_credentials_env: Object.fromEntries(ir.auth.credential_fields.map((f) => [f, `${prefix}_${envPrefix(f)}`])) }
        : {}),
    },
    tools,
  };
}

const EFFECT_NOTE: Record<Effects, string> = {
  read: "read-only",
  write: "WRITES data — enable deliberately",
  destructive: "DESTRUCTIVE — enable deliberately",
  unknown: "effects unknown — review before enabling",
};

/** Render the config with review comments next to each tool. */
export function renderConfig(config: ForgeConfig, ir: ForgeIR): string {
  const doc = new YAML.Document(config);
  doc.commentBefore =
    " forge.config.yaml — review before running `mcp-forge generate`.\n" +
    " Only enabled tools are generated. Write/destructive tools start disabled.\n" +
    " Secrets are read from the environment variables named here, never stored.";
  const toolsNode = doc.get("tools", true) as YAML.YAMLMap;
  for (const pair of toolsNode.items) {
    const id = String((pair.key as YAML.Scalar).value);
    const op = ir.operations.find((o) => o.id === id);
    if (!op) continue;
    const line = bindingLine(op.binding);
    const unknowns = op.unknowns.length ? ` · ${op.unknowns.length} unknown(s)` : "";
    (pair.key as YAML.Scalar).commentBefore = ` ${line} · ${EFFECT_NOTE[op.effects]} · ${op.confidence}, ${op.sample_count} sample(s)${unknowns}`;
  }
  const groups = doc.get("groups", true) as YAML.YAMLMap | undefined;
  if (groups) groups.commentBefore = " Groups expose several operations as one tool with an `action` argument; members keep their own enabled flag.";
  const inferred = doc.get("inferred_operations", true) as YAML.YAMLMap | undefined;
  if (inferred) inferred.commentBefore = " Seen only in code, never in traffic: schemas are unverified. Enable only after checking.";
  return doc.toString({ lineWidth: 0 });
}

export function parseConfig(text: string): ForgeConfig {
  return ForgeConfig.parse(YAML.parse(text));
}

/** Turn a code-only endpoint from the config into an IR operation. */
export function inferredOperation(id: string, spec: InferredOperationConfig, ir: ForgeIR): Operation {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const params: HttpParam[] = [];
  for (const p of spec.params) {
    properties[p.name] = { type: p.type, ...(p.description ? { description: p.description } : {}) };
    if (p.required || p.in === "path") required.push(p.name);
    params.push({ name: p.name, in: p.in });
  }
  const read = spec.effects === "read";
  return {
    id,
    name: spec.name,
    description: spec.description,
    binding: {
      kind: "http",
      method: spec.method.toUpperCase(),
      origin: ir.target.base_url ?? "",
      path_template: spec.path_template,
      params,
      json_body: params.some((p) => p.in === "body"),
      success_statuses: [],
    },
    input: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
    auth: ir.auth.kind === "cookie-session" ? "session" : "none",
    effects: spec.effects,
    idempotent: read || spec.method.toUpperCase() === "PUT" || spec.method.toUpperCase() === "DELETE",
    confidence: "inferred",
    sample_count: 0,
    evidence: spec.evidence.map((e) => {
      const [evidence_id, note] = e.split("#");
      return { evidence_id: evidence_id!, ...(note ? { note } : {}) };
    }),
    unknowns: ["Never observed in traffic; inferred from code. Output shape is unknown."],
  };
}

/** Walk a dotted output path (`items.color`) through object/array schemas. */
export function schemaAtPath(schema: JsonSchema | undefined, path: string): JsonSchema | undefined {
  let node = schema;
  for (const part of path.split(".")) {
    while (node?.type === "array") node = node.items as JsonSchema;
    node = (node?.properties as Record<string, JsonSchema> | undefined)?.[part];
    if (!node) return undefined;
  }
  return node;
}

/** Apply param/output overrides from the config onto a copy of an operation. */
export function applyOverrides(op: Operation, tool: ToolConfig): Operation {
  const next = structuredClone(op);
  next.name = tool.name;
  if (tool.description) next.description = tool.description;
  if (tool.effects) next.effects = tool.effects;
  const props = (next.input.properties ?? {}) as Record<string, JsonSchema>;
  if (tool.cli_arguments?.length) {
    if (next.binding.kind !== "cli") throw new Error(`forge.config.yaml: ${op.id} is not a CLI command; cli_arguments do not apply`);
    const binding = next.binding;
    const required = new Set((next.input.required ?? []) as string[]);
    for (const a of tool.cli_arguments) {
      // A correction replaces whatever the parser produced for the same flag or name.
      const replaced = binding.options.filter((o) => o.name === a.name || (a.flag && o.flag === a.flag));
      for (const r of replaced) {
        delete props[r.name];
        required.delete(r.name);
      }
      binding.options = binding.options.filter((o) => !replaced.includes(o));
      const scalar: JsonSchema = { type: a.type, ...(a.choices?.length ? { enum: a.choices } : {}) };
      props[a.name] = a.takes_value
        ? a.repeatable
          ? { type: "array", items: scalar, ...(a.description ? { description: a.description } : {}) }
          : { ...scalar, ...(a.description ? { description: a.description } : {}) }
        : { type: "boolean", ...(a.description ? { description: a.description } : {}) };
      binding.options.push({
        name: a.name,
        ...(a.flag ? { flag: a.flag } : {}),
        ...(a.positional !== undefined ? { positional: a.positional } : {}),
        takes_value: a.takes_value,
        ...(a.repeatable ? { repeatable: true } : {}),
      });
      if (a.required) required.add(a.name);
    }
    next.input.properties = props;
    if (required.size) next.input.required = [...required];
    else delete next.input.required;
  }
  // Pinned arguments are the server's to fill; the agent never sees them.
  for (const arg of Object.keys(tool.pinned ?? {})) {
    delete props[arg];
    if (Array.isArray(next.input.required)) {
      next.input.required = (next.input.required as string[]).filter((r) => r !== arg);
      if (!(next.input.required as string[]).length) delete next.input.required;
    }
  }
  for (const [arg, o] of Object.entries(tool.params ?? {})) {
    const target = props[arg];
    if (!target) throw new Error(`forge.config.yaml: ${op.id} has no argument "${arg}"`);
    if (o.description) target.description = o.description;
    if (o.format) target.format = o.format;
    if (o.enum && target.type === "string") {
      target.enum = o.enum;
      delete target.examples;
    }
  }
  for (const [path, o] of Object.entries(tool.outputs ?? {})) {
    const target = schemaAtPath(next.output, path);
    if (!target) throw new Error(`forge.config.yaml: ${op.id} output has no field "${path}"`);
    // Known values document the field; they are not enforced, so an unseen
    // value from the live service never fails output validation.
    const known = o.known_values?.length ? ` Known values: ${o.known_values.join(", ")}.` : "";
    if (o.description || known) target.description = `${o.description ?? ""}${known}`.trim();
  }
  return next;
}

export interface ResolvedTool {
  operation: Operation;
  config: ToolConfig;
}

export interface ResolvedGroup {
  name: string;
  config: GroupConfig;
  actions: { action: string; operation: Operation; config: ToolConfig }[];
}

export interface Resolved {
  tools: ResolvedTool[];
  groups: ResolvedGroup[];
  /** Enabled operations left out because verify quarantined them. */
  quarantined: { id: string; name: string; reason: string; since: string }[];
  /** Every operation (observed and inferred), for pins and guards to reference. */
  operations: Map<string, Operation>;
}

/**
 * Apply the config to the IR. Enabled operations become tools, except those
 * that belong to an enabled group, which become actions of the group tool.
 */
export function resolveConfig(ir: ForgeIR, config: ForgeConfig): Resolved {
  const operations = new Map(ir.operations.map((o) => [o.id, o]));
  const toolConfigs = new Map(Object.entries(config.tools));
  for (const [id, spec] of Object.entries(config.inferred_operations ?? {})) {
    if (operations.has(id)) throw new Error(`forge.config.yaml: inferred operation "${id}" duplicates an observed one`);
    operations.set(id, inferredOperation(id, spec, ir));
    toolConfigs.set(id, { enabled: spec.enabled, name: spec.name, description: spec.description, effects: spec.effects });
  }
  for (const id of toolConfigs.keys()) if (!operations.has(id)) throw new Error(`forge.config.yaml names unknown operation "${id}"`);

  const names = new Set<string>();
  const claim = (name: string) => {
    if (names.has(name)) throw new Error(`duplicate tool name "${name}" in forge.config.yaml`);
    names.add(name);
  };

  const quarantined: Resolved["quarantined"] = [];
  for (const [id, tool] of toolConfigs) {
    if (tool.enabled && tool.quarantined) quarantined.push({ id, name: tool.name, ...tool.quarantined });
  }
  const live = (tool: ToolConfig | undefined) => Boolean(tool?.enabled && !tool.quarantined);

  const grouped = new Set<string>();
  const groups: ResolvedGroup[] = [];
  for (const [name, group] of Object.entries(config.groups ?? {})) {
    if (!group.enabled) continue;
    const actions: ResolvedGroup["actions"] = [];
    for (const [action, id] of Object.entries(group.actions)) {
      const op = operations.get(id);
      if (!op) throw new Error(`forge.config.yaml: group "${name}" names unknown operation "${id}"`);
      const tool = toolConfigs.get(id);
      if (!live(tool)) continue;
      if (grouped.has(id)) throw new Error(`forge.config.yaml: operation "${id}" is in more than one enabled group`);
      grouped.add(id);
      actions.push({ action, operation: applyOverrides(op, tool!), config: tool! });
    }
    if (actions.length === 0) continue;
    claim(name);
    groups.push({ name, config: group, actions });
  }

  const tools: ResolvedTool[] = [];
  for (const [id, tool] of toolConfigs) {
    if (!live(tool) || grouped.has(id)) continue;
    claim(tool.name);
    tools.push({ operation: applyOverrides(operations.get(id)!, tool), config: tool });
  }
  return { tools, groups, quarantined, operations };
}

/** Back-compat helper: the enabled standalone tools. */
export function resolveTools(ir: ForgeIR, config: ForgeConfig): ResolvedTool[] {
  return resolveConfig(ir, config).tools;
}
