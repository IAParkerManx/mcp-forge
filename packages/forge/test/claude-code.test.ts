// The Claude Code backend against a stand-in `claude` executable.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AnthropicBackend, ClaudeCodeBackend, createBackend, type LlmRequest } from "../src/llm/backend.ts";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const schema = z.object({ tools: z.array(z.object({ name: z.string() })), notes: z.array(z.string()) });
const request: LlmRequest<z.infer<typeof schema>> = { stage: "curate", system: "SYSTEM PROMPT", user: '{"operations":[]}', schema, effort: "medium" };
const answer = { tools: [{ name: "list_notes" }], notes: [] };
const saved = { ...process.env };
let log: string;

beforeEach(async () => {
  log = join(await mkdtemp(join(tmpdir(), "fake-claude-")), "call.json");
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_ANSWER = JSON.stringify(answer);
});
afterEach(() => {
  process.env = { ...saved };
});

const backend = () => new ClaudeCodeBackend({ command: FAKE, model: "claude-opus-5-5" });

describe("ClaudeCodeBackend", () => {
  it("runs a locked-down headless session and returns the structured answer", async () => {
    process.env.CLAUDE_CODE_SIMPLE = "1";
    const result = await backend().run(request);
    expect(result).toEqual({ status: "ok", output: answer, model: "claude-code:claude-opus-5-5", cached: false });
    const call = JSON.parse(await readFile(log, "utf8"));
    const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--restricted", "--disable-slash-commands", "--no-session-persistence"]));
    expect(flag("--tools")).toBe("");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--system-prompt")).toBe("SYSTEM PROMPT");
    expect(flag("--effort")).toBe("medium");
    expect(JSON.parse(flag("--json-schema"))).toMatchObject({ type: "object", required: ["tools", "notes"] });
    // The prompt travels over stdin, not argv; the session runs in an empty temp dir.
    expect(call.stdin).toBe('{"operations":[]}');
    expect(call.args.join(" ")).not.toContain("operations");
    expect(call.cwd).toMatch(/forge-claude-/);
    expect(call.simple).toBeNull();
  });

  it("accepts JSON in the result text when structured_output is absent", async () => {
    process.env.FAKE_CLAUDE_MODE = "result-json";
    expect(await backend().run(request)).toMatchObject({ status: "ok", output: answer });
  });

  it.each([
    ["logged-out", /not signed in\. Run `claude auth login`/],
    ["text", /returned text instead of the requested JSON/],
    ["bad-shape", /did not match the schema/],
  ])("reports %s as unavailable", async (mode, reason) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    const result = await backend().run(request);
    expect(result.status).toBe("unavailable");
    expect((result as { reason: string }).reason).toMatch(reason);
  });

  it("reports a refusal", async () => {
    process.env.FAKE_CLAUDE_MODE = "refusal";
    expect(await backend().run(request)).toMatchObject({ status: "refused" });
  });

  it("explains a missing CLI", async () => {
    const result = await new ClaudeCodeBackend({ command: "/nonexistent/claude" }).run(request);
    expect((result as { reason: string }).reason).toMatch(/Claude Code CLI not found/);
  });
});

describe("createBackend", () => {
  it("prefers an API credential, then Claude Code", () => {
    expect(createBackend("auto", "m", { ANTHROPIC_API_KEY: "x" })).toBeInstanceOf(AnthropicBackend);
    expect(createBackend("auto", "m", {})).toBeInstanceOf(ClaudeCodeBackend);
    expect(createBackend("anthropic-api", "m", {})).toBeInstanceOf(AnthropicBackend);
  });
});
