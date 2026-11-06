// Capability IR: the target-agnostic description of what a target can do.
// Extractors produce it from REA Evidence; curation edits it; codegen consumes it.
import { z } from "zod";

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const EvidenceRef = z.object({
  evidence_id: z.string(),
  /** Producer record ordinals or other locators inside the Evidence. */
  records: z.array(z.number().int()).optional(),
  note: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Effects = z.enum(["read", "write", "destructive", "unknown"]);
export type Effects = z.infer<typeof Effects>;

/** Where an argument goes when the operation is invoked over HTTP. */
export const HttpParam = z.object({
  name: z.string(),
  in: z.enum(["path", "query", "body"]),
  /** Original wire name when it differs from the tool argument name. */
  wire_name: z.string().optional(),
});
export type HttpParam = z.infer<typeof HttpParam>;

export const HttpBinding = z.object({
  kind: z.literal("http"),
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  params: z.array(HttpParam),
  /** True when the whole request body is one JSON object built from `in: body` params. */
  json_body: z.boolean(),
  success_statuses: z.array(z.number().int()),
  response_content_type: z.string().optional(),
});
export type HttpBinding = z.infer<typeof HttpBinding>;

export const CliBinding = z.object({
  kind: z.literal("cli"),
  command: z.string(),
  subcommand: z.array(z.string()),
  /** How each tool argument becomes argv: a flag (with or without a value) or a positional slot. */
  options: z.array(
    z.object({
      name: z.string(),
      flag: z.string().optional(),
      positional: z.number().int().optional(),
      takes_value: z.boolean(),
      repeatable: z.boolean().optional(),
    }),
  ),
  /** Always passed after the subcommand, e.g. `--json` to get machine-readable output. */
  fixed_args: z.array(z.string()).default([]),
  /** Exact argv with `{arg}` placeholders; when set, it replaces subcommand/options/fixed_args. */
  argv_template: z.array(z.string()).optional(),
  output: z.enum(["json", "text", "lines"]),
});
export type CliBinding = z.infer<typeof CliBinding>;

/** A function an Electron app exposes to its renderer via contextBridge, called over CDP. */
export const ElectronBinding = z.object({
  kind: z.literal("electron"),
  /** The `window.<api>` key passed to contextBridge.exposeInMainWorld. */
  api: z.string(),
  member: z.string(),
  /** Parameter names in call order; tool arguments map onto these positions. */
  params: z.array(z.string()),
  /** Trailing rest parameter (`...args`), if any. */
  rest: z.string().optional(),
  /** IPC channel the member forwards to, when static analysis paired one. */
  channel: z.string().optional(),
  ipc_mode: z.enum(["invoke", "send", "unknown"]),
  /** Substring of the renderer page URL that exposes the API (e.g. `index.html`). */
  page_url_hint: z.string().optional(),
});
export type ElectronBinding = z.infer<typeof ElectronBinding>;

/** An exported Android component, driven over adb: a content provider URI or an activity intent. */
export const AdbBinding = z.object({
  kind: z.literal("adb"),
  package: z.string(),
  op: z.enum(["provider-query", "provider-insert", "provider-update", "provider-delete", "activity"]),
  /** Provider operations: `content://authority/path/{arg}`. */
  uri_template: z.string().optional(),
  /** Provider insert/update: tool argument → column with an adb bind type (s, i, l, f, d, b). */
  binds: z.array(z.object({ name: z.string(), column: z.string(), type: z.enum(["s", "i", "l", "f", "d", "b"]) })).default([]),
  /** Provider query: known columns and their types, for parsing rows. */
  columns: z.array(z.object({ name: z.string(), type: z.enum(["string", "integer", "number"]) })).default([]),
  /** Activity: explicit component (`pkg/.Cls`), optional action and data URI template. */
  component: z.string().optional(),
  intent_action: z.string().optional(),
  data_uri_template: z.string().optional(),
  /** Activity: tool argument → intent extra key with an `am` extra flag type. */
  extras: z.array(z.object({ name: z.string(), key: z.string(), type: z.enum(["s", "i", "l", "f", "z"]) })).default([]),
});
export type AdbBinding = z.infer<typeof AdbBinding>;

export const Binding = z.discriminatedUnion("kind", [HttpBinding, CliBinding, ElectronBinding, AdbBinding]);
export type Binding = z.infer<typeof Binding>;

/** One-line human description of how an operation is invoked. */
export function bindingLine(binding: Binding): string {
  switch (binding.kind) {
    case "http":
      return `${binding.method} ${binding.path_template}`;
    case "cli":
      return [binding.command.split("/").at(-1), ...(binding.argv_template ?? [...binding.subcommand, ...binding.fixed_args])].join(" ");
    case "adb":
      return binding.op === "activity"
        ? `am start ${binding.component}${binding.intent_action ? ` -a ${binding.intent_action}` : ""}${binding.data_uri_template ? ` -d ${binding.data_uri_template}` : ""}`
        : `content ${binding.op.slice("provider-".length)} ${binding.uri_template}`;
    case "electron": {
      const params = [...binding.params, ...(binding.rest ? [`...${binding.rest}`] : [])].join(", ");
      return `${binding.api}.${binding.member}(${params})${binding.channel ? ` → ipc ${binding.channel}` : ""}`;
    }
  }
}

export const Pagination = z.object({
  style: z.enum(["cursor", "offset", "page"]),
  request_param: z.string(),
  response_field: z.string(),
});
export type Pagination = z.infer<typeof Pagination>;

export const Operation = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  binding: Binding,
  input: JsonSchema,
  /** Undefined when the operation returns nothing structured (e.g. 204). */
  output: JsonSchema.optional(),
  /** When the output schema had to be wrapped to make it an object. */
  output_wrapped_as: z.string().optional(),
  auth: z.enum(["none", "session"]),
  effects: Effects,
  idempotent: z.boolean(),
  pagination: Pagination.optional(),
  confidence: z.enum(["observed", "inferred"]),
  sample_count: z.number().int(),
  evidence: z.array(EvidenceRef),
  unknowns: z.array(z.string()),
});
export type Operation = z.infer<typeof Operation>;

/** How a generated server establishes an authenticated session. */
export const AuthModel = z.object({
  kind: z.enum(["none", "cookie-session", "token"]),
  /** Token auth: the header that carries it and its scheme ("Bearer", or "" for raw API-key headers). */
  token: z
    .object({
      header: z.string(),
      scheme: z.string(),
      /** Whether the scheme was seen or assumed (REA withholds Authorization values). */
      scheme_observed: z.boolean(),
      /** Environment variable the user recorded with, reused for the generated server. */
      env_hint: z.string().optional(),
      file_hint: z.string().optional(),
    })
    .optional(),
  /** Operation id of the observed login request, if any. */
  login_operation: z.string().optional(),
  /** The observed login request line; replayed with credentials from the environment. */
  login_request: z.object({ method: z.string(), path: z.string() }).optional(),
  /** Login body fields whose values must come from the environment. */
  credential_fields: z.array(z.string()).default([]),
  /** Anti-CSRF header echoed on writes, and where its value came from. */
  csrf: z
    .object({
      header: z.string(),
      source_operation: z.string(),
      source_method: z.string(),
      source_path: z.string(),
      source_pointer: z.string(),
    })
    .optional(),
  evidence: z.array(EvidenceRef).default([]),
});
export type AuthModel = z.infer<typeof AuthModel>;

export const Fixture = z.object({
  operation_id: z.string(),
  /** Producer ordinal of the captured request; replay follows this order. */
  ordinal: z.number().int(),
  arguments: z.record(z.string(), z.unknown()),
  /** HTTP status for web fixtures. */
  status: z.number().int().optional(),
  /** Exit code for CLI fixtures. */
  exit_code: z.number().int().optional(),
  /** Arguments whose captured value first appeared in an earlier response. */
  derived: z.array(z.object({ argument: z.string(), from_ordinal: z.number().int(), pointer: z.string() })).default([]),
  /** Response body after secret redaction; used for shape checks, not equality. */
  response: z.unknown().optional(),
  evidence: EvidenceRef,
});
export type Fixture = z.infer<typeof Fixture>;

/** A sample worth replaying: HTTP 2xx or exit code 0. */
export function fixtureSucceeded(f: Fixture): boolean {
  if (f.exit_code !== undefined) return f.exit_code === 0;
  return f.status !== undefined && f.status >= 200 && f.status < 300;
}

export const ForgeIR = z.object({
  ir_version: z.literal(1),
  target: z.object({
    kind: z.enum(["web", "cli", "electron", "android", "tauri"]),
    name: z.string(),
    base_url: z.string().optional(),
    /** CLI targets: the executable as investigated (name on PATH or absolute path). */
    command: z.string().optional(),
    /** Electron targets: application path (main entry, directory or .asar) and executable. */
    app_path: z.string().optional(),
    electron_executable: z.string().optional(),
    /** Android targets: APK path and package name. */
    apk_path: z.string().optional(),
    package: z.string().optional(),
  }),
  rea_version: z.string(),
  operations: z.array(Operation),
  auth: AuthModel,
  fixtures: z.array(Fixture),
  /** Client source trees analyzed by REA; `--enrich` quotes excerpts from them. */
  sources: z
    .array(
      z.object({
        evidence_id: z.string(),
        root: z.string(),
        files: z.array(z.object({ path: z.string(), sha256: z.string() })),
      }),
    )
    .default([]),
  /** CLI targets: captured help text per command path, for `plan --cli-help`. */
  cli_help: z.array(z.object({ path: z.array(z.string()), evidence_id: z.string(), text: z.string() })).default([]),
  /** Findings that did not become operations, kept for the review step. */
  notes: z.array(z.string()),
});
export type ForgeIR = z.infer<typeof ForgeIR>;
