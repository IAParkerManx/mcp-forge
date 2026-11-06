// LLM backend for the optional Claude-powered stages. Every stage asks for one
// structured, schema-validated answer, caches it by content hash, and degrades
// to "unavailable" or "refused" instead of failing the pipeline.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface LlmRequest<T> {
  stage: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort: "low" | "medium" | "high";
}

export type LlmResult<T> =
  | { status: "ok"; output: T; model: string; cached: boolean }
  | { status: "refused"; category: string | null; explanation?: string }
  | { status: "unavailable"; reason: string };

export interface LlmBackend {
  readonly model: string;
  run<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export class AnthropicBackend implements LlmBackend {
  readonly model: string;
  private client: Anthropic | undefined;

  constructor(model = DEFAULT_MODEL) {
    this.model = model;
  }

  async run<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    try {
      // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
      this.client ??= new Anthropic();
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
      });
      if (response.stop_reason === "refusal") {
        const details = response.stop_details as { category?: string | null; explanation?: string } | null | undefined;
        return { status: "refused", category: details?.category ?? null, ...(details?.explanation ? { explanation: details.explanation } : {}) };
      }
      if (response.stop_reason === "max_tokens") return { status: "unavailable", reason: "response hit max_tokens before completing" };
      if (response.parsed_output == null) return { status: "unavailable", reason: "response did not match the requested schema" };
      return { status: "ok", output: response.parsed_output as T, model: response.model, cached: false };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return { status: "unavailable", reason: "Claude credentials were rejected" };
      }
      if (error instanceof Anthropic.APIError) return { status: "unavailable", reason: `Claude API error ${error.status ?? ""}: ${error.message}` };
      const message = (error as Error).message ?? String(error);
      if (/authentication method|apiKey|authToken/i.test(message)) {
        return { status: "unavailable", reason: "Claude is not configured. Set ANTHROPIC_API_KEY or run `ant auth login`." };
      }
      // e.g. a structured response that failed schema validation
      return { status: "unavailable", reason: `Claude call failed: ${message}` };
    }
  }
}

export interface ClaudeCodeOptions {
  model?: string;
  /** Path to the `claude` executable (default: `claude` on PATH, or FORGE_CLAUDE_BIN). */
  command?: string;
  timeoutMs?: number;
}

/**
 * Runs each request through Claude Code's headless mode (`claude -p`), using
 * whatever account the `claude` CLI is signed in with, so no API key is needed.
 * The session is locked down: no tools, no MCP servers, no skills, no user or
 * project settings, no saved session, and an empty working directory so no
 * CLAUDE.md is picked up. The prompt goes over stdin; the answer must match
 * the JSON Schema passed with --json-schema.
 */
export class ClaudeCodeBackend implements LlmBackend {
  readonly model: string;
  private readonly cliModel: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCodeOptions = {}) {
    this.cliModel = options.model ?? DEFAULT_MODEL;
    this.model = `claude-code:${this.cliModel}`;
    this.command = options.command ?? process.env.FORGE_CLAUDE_BIN ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async run<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(request.schema) as Record<string, unknown>;
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--system-prompt", request.system,
      "--tools", "",
      "--strict-mcp-config",
      "--restricted",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--model", this.cliModel,
      "--effort", request.effort,
    ];
    const cwd = await mkdtemp(join(tmpdir(), "forge-claude-"));
    let out: { code: number | null; stdout: string; stderr: string };
    try {
      out = await this.exec(args, request.user, cwd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "unavailable", reason: `Claude Code CLI not found (\`${this.command}\`). Install Claude Code or use --llm-backend anthropic-api.` };
      return { status: "unavailable", reason: `Claude Code failed: ${(error as Error).message}` };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }

    let envelope: { is_error?: boolean; result?: string; stop_reason?: string; structured_output?: unknown; model?: string; modelUsage?: Record<string, unknown> };
    try {
      envelope = JSON.parse(out.stdout);
    } catch {
      return { status: "unavailable", reason: `Claude Code exited ${out.code} without JSON output: ${(out.stderr || out.stdout).trim().slice(0, 300)}` };
    }
    if (envelope.stop_reason === "refusal") return { status: "refused", category: null, ...(envelope.result ? { explanation: envelope.result } : {}) };
    if (envelope.is_error) {
      const message = String(envelope.result ?? "unknown error");
      if (/not logged in|\/login|authenticat/i.test(message)) {
        return { status: "unavailable", reason: "Claude Code is not signed in. Run `claude auth login` in a terminal once, then retry." };
      }
      return { status: "unavailable", reason: `Claude Code error: ${message.slice(0, 300)}` };
    }
    let candidate = envelope.structured_output;
    if (candidate === undefined && typeof envelope.result === "string") {
      try {
        candidate = JSON.parse(envelope.result);
      } catch {
        return { status: "unavailable", reason: "Claude Code returned text instead of the requested JSON" };
      }
    }
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) return { status: "unavailable", reason: `Claude Code's answer did not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    const served = Object.keys(envelope.modelUsage ?? {})[0] ?? this.cliModel;
    return { status: "ok", output: parsed.data, model: `claude-code:${served}`, cached: false };
  }

  private exec(args: string[], input: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    // Inside a Claude Code desktop session these variables point the child at
    // the host session (API-key-only mode, session proxy). Drop them so the CLI
    // uses its own sign-in.
    const env = { ...process.env };
    for (const key of ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDECODE"]) delete env[key];
    if (env.CLAUDE_CODE_DESKTOP_APP_VERSION) delete env.ANTHROPIC_BASE_URL;
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`timed out after ${Math.round(this.timeoutMs / 1000)}s`));
      }, this.timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on("error", () => {
        // The child may exit before reading stdin (e.g. not signed in).
      });
      child.stdin.end(input);
    });
  }
}

export type BackendName = "auto" | "claude-code" | "anthropic-api";

/** Pick a backend: an API credential wins; otherwise a local Claude Code install. */
export function createBackend(name: BackendName, model: string, env: NodeJS.ProcessEnv = process.env): LlmBackend {
  if (name === "anthropic-api") return new AnthropicBackend(model);
  if (name === "claude-code") return new ClaudeCodeBackend({ model });
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return new AnthropicBackend(model);
  return new ClaudeCodeBackend({ model });
}

/** Content-hash cache: identical requests are answered from disk, so re-runs are free and reproducible. */
export class CachedBackend implements LlmBackend {
  readonly model: string;
  private readonly inner: LlmBackend;
  private readonly dir: string;

  constructor(inner: LlmBackend, dir: string) {
    this.inner = inner;
    this.model = inner.model;
    this.dir = dir;
  }

  private key<T>(request: LlmRequest<T>): string {
    const schema = z.toJSONSchema(request.schema);
    return createHash("sha256")
      .update(JSON.stringify([this.model, request.stage, request.effort, request.system, request.user, schema]))
      .digest("hex");
  }

  async run<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const path = join(this.dir, `${request.stage}-${this.key(request).slice(0, 32)}.json`);
    try {
      const hit = JSON.parse(await readFile(path, "utf8")) as { model: string; output: unknown };
      return { status: "ok", output: request.schema.parse(hit.output), model: hit.model, cached: true };
    } catch {
      // miss or stale entry
    }
    const result = await this.inner.run(request);
    if (result.status === "ok") {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, JSON.stringify({ stage: request.stage, model: result.model, output: result.output }, null, 2) + "\n");
    }
    return result;
  }
}
