// Thin MCP client over `rea mcp` (stdio). REA contracts change between minor
// releases, so the version is pinned. Retained `ev_…` ids only resolve inside
// one connection, so callers persist what they need with `saveEvidence`.
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactLiterals } from "../synth/redact.ts";

export const REA_VERSION = "6.4.0";

export interface ReaEvidence {
  evidence_id: string;
  operation: string;
  confidence: string;
  normalized_result: Record<string, unknown>;
  limitations?: string[];
  [key: string]: unknown;
}

export class ReaError extends Error {
  readonly tool: string;
  readonly detail: unknown;
  constructor(tool: string, detail: unknown) {
    super(`REA ${tool} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.tool = tool;
    this.detail = detail;
  }
}

export interface ReaClientOptions {
  /** Override the launcher, e.g. a locally installed `rea` binary. */
  command?: string;
  args?: string[];
  /** Extra environment for REA and the processes it launches (merged over a safe default set). */
  env?: Record<string, string>;
}

export class ReaClient {
  private readonly client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(options: ReaClientOptions = {}): Promise<ReaClient> {
    const transport = new StdioClientTransport({
      command: options.command ?? "npx",
      args: options.args ?? ["-y", `rea-agents@${REA_VERSION}`, "mcp"],
      ...(options.env ? { env: { ...getDefaultEnvironment(), ...options.env } } : {}),
      stderr: "pipe",
    });
    const client = new Client({ name: "mcp-forge", version: "0.1.0" });
    await client.connect(transport);
    return new ReaClient(client);
  }

  async listTools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  }

  /** Call a REA tool and return its structured result. */
  async call<T = ReaEvidence>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    if (result.isError) {
      const text = result.content.find((c) => c.type === "text");
      let detail: unknown = text && "text" in text ? text.text : result.content;
      try {
        detail = JSON.parse(String(detail));
      } catch {
        // keep raw text
      }
      throw new ReaError(tool, detail);
    }
    const structured = result.structuredContent as T | undefined;
    if (structured === undefined) throw new ReaError(tool, "no structuredContent in result");
    return structured;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Persist Evidence as `<evidence_id>.json` after replacing known secret values
 * (captured passwords and tokens, secret environment values) wherever they appear.
 * The id still names REA's original content hash; the saved copy is marked as
 * redacted because its bytes no longer hash to that id.
 */
export async function saveEvidence(dir: string, evidence: ReaEvidence, secrets: ReadonlySet<string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${evidence.evidence_id}.json`);
  const copy = { ...redactLiterals(evidence, secrets), "mcp-forge/redacted": true };
  await writeFile(path, JSON.stringify(copy, null, 2) + "\n");
  return path;
}
