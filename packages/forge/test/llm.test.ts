// LLM stages with recorded Claude responses: no API calls in CI. These tests
// pin the guardrails — citations, verbatim enums, risk never silently lowered,
// refusals falling back to the deterministic config — and the codegen of
// accepted suggestions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { extractWeb } from "../src/extract/har.ts";
import { draftConfig, resolveConfig, type ForgeConfig } from "../src/curate/config.ts";
import { buildManifest, generateServer } from "../src/codegen/generate.ts";
import { verifyServer } from "../src/verify/replay.ts";
import type { ForgeIR } from "../src/ir/types.ts";
import { CachedBackend, type LlmBackend, type LlmRequest, type LlmResult } from "../src/llm/backend.ts";
import { collectExcerpts, operationDigest, redactCode, type Excerpt } from "../src/llm/context.ts";
import { applyEnrich, type EnrichSuggestion } from "../src/llm/enrich.ts";
import { applyCurate, type CurateSuggestion } from "../src/llm/curate.ts";
import { lineDiff, runPlanStages } from "../src/llm/patch.ts";
import { evidenceFromHar } from "./helpers.ts";
// @ts-expect-error untyped example module
import { recordHar } from "../../../examples/targets/web-demo/record-har.mjs";
// @ts-expect-error untyped example module
import { createApp } from "../../../examples/targets/web-demo/server.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("../../../examples/targets/web-demo/public/", import.meta.url));
const SRC_EV = "ev_source0000000000000000";

class FakeBackend implements LlmBackend {
  readonly model = "fake-model";
  calls: string[] = [];
  private readonly answers: Record<string, LlmResult<unknown>>;
  constructor(answers: Record<string, LlmResult<unknown>>) {
    this.answers = answers;
  }
  async run<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(request.stage);
    const answer = this.answers[request.stage] ?? { status: "unavailable", reason: "no recorded answer" };
    if (answer.status === "ok") return { ...answer, output: request.schema.parse(answer.output) };
    return answer as LlmResult<T>;
  }
}

let ir: ForgeIR;
let config: ForgeConfig;
let excerpts: Excerpt[];
let excerptId: string;
let evId: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-llm-"));
  const har = JSON.parse(await readFile(await recordHar(join(dir, "demo.har")), "utf8"));
  ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
  ir.sources = [{ evidence_id: SRC_EV, root: SOURCE_ROOT, files: [{ path: "app.js", sha256: "x" }] }];
  config = draftConfig(ir);
  excerpts = await collectExcerpts(ir);
  excerptId = excerpts.find((e) => e.text.includes("archive"))!.id;
  evId = ir.operations[0]!.evidence[0]!.evidence_id;
});

const enrichAnswer = (): EnrichSuggestion => ({
  params: [
    { operation_id: "post_api_notes", argument: "color", description: "Note color.", enum: ["yellow", "blue", "green"], format: null, excerpts: [excerptId] },
    { operation_id: "get_api_notes", argument: "tag", description: "Only notes with this tag.", enum: ["work", "urgent"], format: null, excerpts: [excerptId] },
    { operation_id: "get_api_notes", argument: "limit", description: "Page size.", enum: null, format: null, excerpts: [] },
    { operation_id: "get_api_notes", argument: "nope", description: "x", enum: null, format: null, excerpts: [excerptId] },
  ],
  outputs: [{ operation_id: "get_api_notes", field_path: "items.color", description: "Display color.", known_values: ["yellow", "blue", "purple"], excerpts: [excerptId] }],
  new_operations: [
    {
      name: "archive_note",
      method: "POST",
      path_template: "/api/notes/{note_id}/archive",
      description: "Archive a note.",
      effects: "read",
      params: [{ name: "note_id", in: "path", type: "string", required: true, description: null }],
      excerpts: [excerptId],
    },
    {
      name: "export_notes",
      method: "GET",
      path_template: "/api/export",
      description: "Export all notes.",
      effects: "read",
      params: [{ name: "format", in: "query", type: "string", required: true, description: "json or markdown" }],
      excerpts: [excerptId],
    },
    {
      name: "login",
      method: "POST",
      path_template: "/api/login",
      description: "Log in.",
      effects: "write",
      params: [{ name: "username", in: "body", type: "string", required: true, description: null }, { name: "password", in: "body", type: "string", required: true, description: null }],
      excerpts: [excerptId],
    },
    { name: "purge", method: "DELETE", path_template: "/api/purge", description: "x", effects: "destructive", params: [], excerpts: [excerptId] },
    { name: "list_notes_again", method: "GET", path_template: "/api/notes", description: "x", effects: "read", params: [], excerpts: [excerptId] },
    { name: "rename", method: "PUT", path_template: "/api/notes/{note_id}/archive", description: "x", effects: "write", params: [{ name: "note_id", in: "path", type: "string", required: true, description: null }], excerpts: [excerptId] },
  ],
  notes: ["Colors come from NOTE_COLORS."],
});

describe("context privacy", () => {
  it("sends no observed values unless asked", () => {
    const op = ir.operations.find((o) => o.id === "get_api_notes")!;
    const quiet = JSON.stringify(operationDigest(op, ir, config, { sendSamples: false }));
    expect(quiet).not.toContain("examples");
    expect(quiet).not.toContain("Groceries");
    const loud = JSON.stringify(operationDigest(op, ir, config, { sendSamples: true }));
    expect(loud).toContain("Groceries");
  });

  it("masks secret literals in code excerpts", () => {
    expect(redactCode(`const apiKey = "sk-live-123456";`)).toBe(`const apiKey = "[REDACTED]";`);
    expect(redactCode(`headers: { authToken: 'abcdefgh' }`)).toBe(`headers: { authToken: '[REDACTED]' }`);
  });

  it("cuts excerpts that include code-only endpoints", () => {
    const text = excerpts.map((e) => e.text).join("\n");
    expect(text).toContain("/api/export");
    expect(excerpts.every((e) => e.evidence_id === SRC_EV)).toBe(true);
  });
});

describe("applyEnrich", () => {
  it("keeps cited, verifiable suggestions and rejects the rest", () => {
    const { config: next, report } = applyEnrich(ir, config, enrichAnswer(), excerpts);
    expect(next.tools["post_api_notes"]!.params!["color"]).toEqual({ description: "Note color.", enum: ["yellow", "blue", "green"], evidence: [`${SRC_EV}#${excerptId}`] });
    // "urgent" is not in the code: the enum is dropped but the description stays.
    expect(next.tools["get_api_notes"]!.params!["tag"]).toEqual({ description: "Only notes with this tag.", evidence: [`${SRC_EV}#${excerptId}`] });
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tag: enum ignored, values not in cited code: work, urgent/),
        expect.stringMatching(/limit: no excerpts cited/),
        expect.stringMatching(/nope: no such operation argument/),
        expect.stringMatching(/\/api\/purge: path segment "purge"/),
        expect.stringMatching(/GET \/api\/notes: already observed/),
        expect.stringMatching(/POST \/api\/login: this is the login request/),
        expect.stringMatching(/PUT .*method PUT is not in the cited code/),
      ]),
    );
    expect(next.tools["get_api_notes"]!.outputs!["items.color"]!.known_values).toEqual(["yellow", "blue"]);
  });

  it("adds code-only endpoints disabled, never below the method's risk", () => {
    const { config: next } = applyEnrich(ir, config, enrichAnswer(), excerpts);
    expect(next.inferred_operations!["post_api_notes_note_id_archive"]).toMatchObject({ enabled: false, method: "POST", effects: "unknown" });
    expect(next.inferred_operations!["get_api_export"]).toMatchObject({ enabled: false, effects: "read" });
  });
});

describe("applyCurate", () => {
  const answer = (): CurateSuggestion => ({
    tools: [
      { operation_id: "get_api_notes", name: "list_notes", description: "List notes, newest first. Filter by tag.", effects: null, effects_reason: null, evidence_ids: [evId] },
      { operation_id: "get_api_search", name: "search_notes", description: "Find notes whose title or body contains a word.", effects: null, effects_reason: null, evidence_ids: [evId] },
      { operation_id: "get_api_me", name: "whoami", description: "x", effects: null, effects_reason: null, evidence_ids: ["ev_made_up"] },
      { operation_id: "delete_api_notes_note_id", name: "delete_note", description: "Delete a note.", effects: "write", effects_reason: "soft delete", evidence_ids: [evId] },
      { operation_id: "patch_api_notes_note_id", name: "list_notes", description: "x", effects: null, effects_reason: null, evidence_ids: [evId] },
      { operation_id: "post_api_notes", name: "create_note", description: "Create a note.", effects: "read", effects_reason: null, evidence_ids: [evId] },
    ],
    groups: [
      { name: "notes", description: "Browse notes.", actions: [{ action: "list", operation_id: "get_api_notes" }, { action: "get", operation_id: "get_api_notes_note_id" }, { action: "search", operation_id: "get_api_search" }], evidence_ids: [evId] },
      { name: "edit_notes", description: "x", actions: [{ action: "get", operation_id: "get_api_notes_note_id" }, { action: "delete", operation_id: "delete_api_notes_note_id" }], evidence_ids: [evId] },
    ],
    notes: [],
  });

  it("applies cited renames and descriptions, and guards risk", () => {
    const { config: next, report } = applyCurate(ir, config, answer());
    expect(next.tools["get_api_search"]!.name).toBe("search_notes");
    expect(next.tools["get_api_notes"]!.description).toBe("List notes, newest first. Filter by tag.");
    expect(next.tools["get_api_me"]!.name).toBe("get_me");
    expect(next.tools["delete_api_notes_note_id"]!.effects).toBeUndefined();
    expect(next.tools["post_api_notes"]!.effects).toBeUndefined();
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/get_api_me: does not cite/),
        expect.stringMatching(/will not lower effects destructive → write/),
        expect.stringMatching(/will not lower effects write → read without a reason/),
        expect.stringMatching(/patch_api_notes_note_id: name "list_notes" is invalid or already used/),
        expect.stringMatching(/group edit_notes: mixes read-only and write/),
      ]),
    );
    expect(next.groups!["notes"]).toMatchObject({ enabled: false, actions: { list: "get_api_notes", get: "get_api_notes_note_id", search: "get_api_search" } });
  });
});

describe("runPlanStages", () => {
  it("falls back to the deterministic config on refusal or missing credentials", async () => {
    const backend = new FakeBackend({ enrich: { status: "refused", category: "cyber" }, curate: { status: "unavailable", reason: "Claude is not configured" } });
    const { config: next, reports } = await runPlanStages(ir, config, backend, { enrich: true, curate: true }, { sendSamples: false });
    expect(next).toEqual(config);
    expect(reports.map((r) => r.skipped)).toEqual([expect.stringMatching(/declined.*cyber/), "Claude is not configured"]);
  });

  it("caches answers by content so re-runs make no calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-cache-"));
    const inner = new FakeBackend({ enrich: { status: "ok", output: enrichAnswer(), model: "fake-model", cached: false } });
    const backend = new CachedBackend(inner, dir);
    const first = await runPlanStages(ir, config, backend, { enrich: true }, { sendSamples: false });
    const second = await runPlanStages(ir, config, backend, { enrich: true }, { sendSamples: false });
    expect(inner.calls).toEqual(["enrich"]);
    expect(second.reports[0]!.cached).toBe(true);
    expect(second.config).toEqual(first.config);
  });

  it("renders a readable diff", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
  });
});

describe("generating from accepted suggestions", () => {
  const work = fileURLToPath(new URL("../.tmp/llm/", import.meta.url));
  let app: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    app = createApp();
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    app?.close();
    await rm(work, { recursive: true, force: true });
  });

  function acceptedConfig(): ForgeConfig {
    let next = applyEnrich(ir, config, enrichAnswer(), excerpts).config;
    next = applyCurate(ir, next, {
      tools: [],
      groups: [{ name: "notes", description: "Browse and search notes.", actions: [{ action: "list", operation_id: "get_api_notes" }, { action: "get", operation_id: "get_api_notes_note_id" }, { action: "search", operation_id: "get_api_search" }], evidence_ids: [evId] }],
      notes: [],
    }).config;
    next.groups!["notes"]!.enabled = true;
    next.tools["post_api_notes"]!.enabled = true;
    next.inferred_operations!["get_api_export"]!.enabled = true;
    return next;
  }

  it("folds grouped operations into one tool and applies documented enums", () => {
    const manifest = buildManifest(ir, acceptedConfig());
    expect(manifest.tools.map((t) => t.name)).toEqual(["create_note", "export_notes", "get_me", "list_tags", "notes"]);
    const notes = manifest.tools.find((t) => t.name === "notes")!;
    expect((notes.input.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual(["list", "get", "search"]);
    expect(notes.annotations.readOnlyHint).toBe(true);
    const create = manifest.tools.find((t) => t.name === "create_note")!;
    expect((create.input.properties as Record<string, { enum?: string[] }>).color!.enum).toEqual(["yellow", "blue", "green"]);
    const list = notes.actions.find((a) => a.action === "list")!;
    expect(JSON.stringify(list.output)).toContain("Known values: yellow, blue.");
    const exportTool = manifest.tools.find((t) => t.name === "export_notes")!;
    expect(exportTool.meta["mcp-forge/confidence"]).toBe("inferred");
    expect(resolveConfig(ir, acceptedConfig()).groups[0]!.actions).toHaveLength(3);
  });

  it("points descriptions at group actions instead of folded-away tools", () => {
    const next = acceptedConfig();
    next.tools["get_api_tags"]!.description = "List tags. Use list_notes or search to filter; not list_notes_v2.";
    const manifest = buildManifest(ir, next);
    const tags = manifest.tools.find((t) => t.name === "list_tags")!;
    expect(tags.description).toContain('Use notes (action "list") or notes (action "search") to filter; not list_notes_v2.');
    const notes = manifest.tools.find((t) => t.name === "notes")!;
    expect(notes.description).toMatch(/^list: Evidence:/m);
  });

  it("replays group actions through the generated server", { timeout: 60_000 }, async () => {
    const manifest = await generateServer(ir, acceptedConfig(), join(work, "server"));
    const env = { WEB_DEMO_BASE_URL: baseUrl, WEB_DEMO_USERNAME: "demo", WEB_DEMO_PASSWORD: "demo-password" };
    const results = await verifyServer(ir, manifest, { serverDir: join(work, "server"), env, includeWrites: true });
    expect(results.find((r) => r.tool === "notes")).toMatchObject({ status: "pass", detail: "8 replay(s) matched the inferred schema" });
    expect(results.find((r) => r.tool === "create_note")!.status).toBe("pass");
    expect(results.find((r) => r.tool === "export_notes")!.status).toBe("skip");
  });
});
