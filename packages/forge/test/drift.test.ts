// M5: drift detection, quarantine, schema refresh and the HTML report, run
// against the demo web app in its "added" and "breaking" drift modes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { extractWeb } from "../src/extract/har.ts";
import { draftConfig, type ForgeConfig } from "../src/curate/config.ts";
import { buildManifest, generateServer } from "../src/codegen/generate.ts";
import { verifyServer, type CheckResult } from "../src/verify/replay.ts";
import { driftOf, isBreaking } from "../src/verify/drift.ts";
import { quarantineFailures, refreshSchemas } from "../src/verify/apply.ts";
import { renderReport } from "../src/report/html.ts";
import type { ForgeIR } from "../src/ir/types.ts";
import { evidenceFromHar } from "./helpers.ts";
// @ts-expect-error untyped example module
import { recordHar } from "../../../examples/targets/web-demo/record-har.mjs";
// @ts-expect-error untyped example module
import { createApp } from "../../../examples/targets/web-demo/server.mjs";

const work = fileURLToPath(new URL("../.tmp/drift/", import.meta.url));
let ir: ForgeIR;
let config: ForgeConfig;

async function serve(drift?: string): Promise<{ app: Server; url: string }> {
  const app = createApp({ drift });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  return { app, url: `http://127.0.0.1:${(app.address() as { port: number }).port}` };
}

async function verifyAgainst(drift: string | undefined, samples?: Map<string, unknown[]>): Promise<CheckResult[]> {
  const { app, url } = await serve(drift);
  try {
    return await verifyServer(ir, buildManifest(ir, config), {
      serverDir: join(work, "server"),
      env: { WEB_DEMO_BASE_URL: url, WEB_DEMO_USERNAME: "demo", WEB_DEMO_PASSWORD: "demo-password" },
      includeWrites: true,
      ...(samples ? { onSample: (id: string, v: unknown) => samples.set(id, [...(samples.get(id) ?? []), v]) } : {}),
    });
  } finally {
    app.close();
  }
}

beforeAll(async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const har = JSON.parse(await readFile(await recordHar(join(work, "demo.har")), "utf8"));
  ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
  config = draftConfig(ir);
  for (const t of Object.values(config.tools)) t.enabled = true;
  await generateServer(ir, config, join(work, "server"));
});
afterAll(() => rm(work, { recursive: true, force: true }));

describe("driftOf", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "string" }, n: { type: "integer" }, tags: { type: "array", items: { type: "object", properties: { k: { type: "string" } }, required: ["k"] } } },
    required: ["id", "n"],
  };
  it("classifies additive and breaking differences", () => {
    expect(driftOf(schema, { id: "a", n: 1, extra: true })).toEqual({ missing: [], changed: [], added: ["extra"] });
    expect(driftOf(schema, { n: 1.5, tags: [{ k: 1 }, {}] })).toEqual({
      missing: ["id", "tags[].k"],
      changed: [
        { path: "n", expected: "integer", actual: "number" },
        { path: "tags[].k", expected: "string", actual: "integer" },
      ],
      added: [],
    });
    expect(isBreaking(driftOf({ type: ["string", "null"] }, null))).toBe(false);
    expect(driftOf({ type: "number" }, 3).changed).toEqual([]);
  });
});

describe("drift against the live demo app", () => {
  it("passes additive drift, reports it, and can fold it into the schema", { timeout: 60_000 }, async () => {
    const samples = new Map<string, unknown[]>();
    const results = await verifyAgainst("added", samples);
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
    const list = results.find((r) => r.tool === "list_notes")!;
    expect(list.drift?.added).toEqual(["items[].archived"]);
    expect(list.detail).toMatch(/additive drift: 1 new field\(s\): items\[\]\.archived/);

    const { ir: refreshed, updated } = refreshSchemas(ir, results, samples);
    expect(updated).toEqual(expect.arrayContaining(["list_notes", "get_note"]));
    const item = (refreshed.operations.find((o) => o.name === "list_notes")!.output as any).properties.items.items;
    expect(item.properties.archived).toEqual({ type: "boolean" });
    // Recorded responses lack the field, so it stays optional.
    expect(item.required).not.toContain("archived");
  });

  it("fails breaking drift and quarantines the affected tools", { timeout: 60_000 }, async () => {
    const results = await verifyAgainst("breaking");
    const failed = results.filter((r) => r.status === "fail").map((r) => r.tool);
    expect(failed).toEqual(["create_note", "get_note", "list_notes"]);
    // The rename shows up as a missing field plus a new one.
    expect(results.find((r) => r.tool === "get_note")!.detail).toBe("output drifted from inferred schema: missing title; 1 new field(s): name");
    // update_note edits the note create_note made; with create_note broken it cannot be tested, so it is skipped, not blamed.
    expect(results.find((r) => r.tool === "update_note")).toMatchObject({ status: "skip", detail: "depends on create_note, which failed" });
    expect(results.find((r) => r.tool === "search")!.status).toBe("pass");
    // delete_note replays the id update_note returned; update_note failed, so delete_note is not blamed.
    expect(results.find((r) => r.tool === "delete_note")).toMatchObject({ status: "skip", detail: "depends on update_note, which failed" });

    const { config: next, quarantined } = quarantineFailures(config, results, "2026-10-14");
    expect(quarantined.sort()).toEqual(["create_note", "get_note", "list_notes"]);
    const manifest = buildManifest(ir, next);
    expect(manifest.tools.map((t) => t.name)).toEqual(["delete_note", "get_me", "list_tags", "search", "update_note"]);
    expect(manifest.quarantined.map((q) => q.name).sort()).toEqual(quarantined.sort());
    await generateServer(ir, next, join(work, "server-q"));
    const readme = await readFile(join(work, "server-q", "README.md"), "utf8");
    expect(readme).toContain("## Quarantined");

    const html = renderReport(ir, next, { at: "2026-10-14T00:00:00Z", include_writes: true, results });
    expect(html).toContain("quarantined");
    expect(html).toContain("missing: <code>title</code>");
  });
});

describe("renderReport", () => {
  it("escapes everything it shows", () => {
    const evil = structuredClone(config);
    evil.tools["get_api_me"]!.description = '<img src=x onerror="alert(1)">';
    const html = renderReport(ir, evil, undefined);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("not verified yet");
    expect(html).toContain(ir.operations[0]!.evidence[0]!.evidence_id);
  });
});
