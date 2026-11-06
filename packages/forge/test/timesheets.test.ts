// Pinned arguments and guards, end to end, on a timesheet server built against
// the local Rippling mock: the agent can log and fix its own draft hours, and
// nothing else, whichever token the server runs with.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { recordHar } from "../src/investigate/record.ts";
import { extractWeb } from "../src/extract/har.ts";
import { draftConfig, type ForgeConfig } from "../src/curate/config.ts";
import { buildManifest, generateServer } from "../src/codegen/generate.ts";
import { verifyServer } from "../src/verify/replay.ts";
import type { ForgeIR } from "../src/ir/types.ts";
import { evidenceFromHar } from "./helpers.ts";
// @ts-expect-error untyped example module
import { createApp, entryId } from "../../../examples/targets/rippling-mock/server.mjs";

const ADA = "6569930dfb7bc7c3510f5bac";
const GRACE = "66a42da5d80b34a7fc92a3df";
const work = fileURLToPath(new URL("../.tmp/timesheets/", import.meta.url));
let ir: ForgeIR;
let config: ForgeConfig;

async function serve(): Promise<{ app: Server; url: string }> {
  const app = createApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  return { app, url: `http://127.0.0.1:${(app.address() as { port: number }).port}` };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "timesheet-test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(work, "server", "server.mjs")], env: { PATH: process.env.PATH ?? "", RIPPLING_BASE_URL: url, RIPPLING_TOKEN: token }, stderr: "pipe" }),
  );
  return client;
}

const text = (r: { content?: unknown }) => JSON.stringify(r.content ?? "");

beforeAll(async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  // 1. Record a session against the mock as Ada (writes are fine: it is a mock).
  const { app, url } = await serve();
  const day1 = entryId(ADA, "2026-01-13");
  try {
    await recordHar({
      baseUrl: url,
      out: join(work, "rippling.har"),
      allowWrites: true,
      secretHeaders: { authorization: "Bearer mock-token-ada" },
      requests: [
        { method: "GET", path: "/me" },
        { method: "GET", path: "/time-entries" },
        { method: "GET", path: "/time-cards" },
        { method: "POST", path: "/time-entries/", body: { worker_id: ADA, duration: 7.5, start_date: "2026-01-13", comments: [{ text: "Camera trap check" }], status: "DRAFT", idempotency_key: `forge-${ADA}-2026-01-13` } },
        { method: "GET", path: `/time-entries/${day1}/` },
        { method: "PATCH", path: `/time-entries/${day1}/`, body: { worker_id: ADA, duration: 8 } },
        { method: "DELETE", path: `/time-entries/${day1}/` },
        { method: "POST", path: "/time-entries/", body: { worker_id: ADA, duration: 4, start_date: "2026-01-14", status: "DRAFT", idempotency_key: `forge-${ADA}-2026-01-14` } },
      ],
    });
  } finally {
    app.close();
  }
  ir = extractWeb(evidenceFromHar(JSON.parse(await readFile(join(work, "rippling.har"), "utf8"))), { targetName: "rippling", reaVersion: "test" });

  // 2. Review: enable the timesheet tools, pin what the agent must not choose, guard edits.
  config = draftConfig(ir);
  const tools = config.tools;
  for (const t of Object.values(tools)) t.enabled = true;
  const me = { from: "get_me", pointer: "/worker_id" };
  const ownDraft = [{ operation: "get_time_entries_time_entry_id", args: { time_entry_id: "{time_entry_id}" }, require: { "/worker_id": "{worker_id}", "/status": "DRAFT" }, message: "you can only change your own draft entries" }];
  tools["post_time_entries"] = { ...tools["post_time_entries"]!, name: "log_time", pinned: { worker_id: me, status: { value: "DRAFT" }, idempotency_key: { template: "forge-{worker_id}-{start_date}" } } };
  tools["patch_time_entries_time_entry_id"] = { ...tools["patch_time_entries_time_entry_id"]!, name: "update_my_draft_entry", pinned: { worker_id: me }, guard: ownDraft };
  tools["delete_time_entries_time_entry_id"] = { ...tools["delete_time_entries_time_entry_id"]!, name: "delete_my_draft_entry", pinned: { worker_id: me }, guard: ownDraft };
  await generateServer(ir, config, join(work, "server"));
});
afterAll(() => rm(work, { recursive: true, force: true }));

describe("pinned arguments", () => {
  it("removes pinned arguments from the tool and says what the server sets", async () => {
    const manifest = buildManifest(ir, config);
    const log = manifest.tools.find((t) => t.name === "log_time")!;
    expect(Object.keys(log.input.properties as object).sort()).toEqual(["comments", "duration", "start_date"]);
    expect(log.input.required).toEqual(["duration", "start_date"]);
    expect(log.description).toContain('Set by the server, not by you: worker_id (from get_me); status = "DRAFT"; idempotency_key (built from other arguments).');
    expect(manifest.support).toHaveProperty("get_me");
    expect(manifest.support).toHaveProperty("get_time_entries_time_entry_id");
  });

  it("refuses pins and guards that reference unknown or non-read-only operations", () => {
    const bad = structuredClone(config);
    bad.tools["post_time_entries"]!.pinned = { worker_id: { from: "delete_time_entries_time_entry_id", pointer: "/x" } };
    expect(() => buildManifest(ir, bad)).toThrow(/not read-only \(destructive\)/);
    bad.tools["post_time_entries"]!.pinned = { worker_id: { from: "nope", pointer: "/x" } };
    expect(() => buildManifest(ir, bad)).toThrow(/unknown operation "nope"/);
  });
});

describe("the generated timesheet server", () => {
  let mock: { app: Server; url: string };
  beforeAll(async () => {
    mock = await serve();
  });
  afterAll(() => mock.app.close());

  it("replays the recorded session, including writes, with pins filled in", { timeout: 60_000 }, async () => {
    const results = await verifyServer(ir, buildManifest(ir, config), { serverDir: join(work, "server"), env: { RIPPLING_BASE_URL: mock.url, RIPPLING_TOKEN: "mock-token-ada" }, includeWrites: true });
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.find((r) => r.tool === "delete_my_draft_entry")!.status).toBe("pass");
  });

  it("logs hours as a DRAFT for the token's owner, whatever the agent tries", { timeout: 60_000 }, async () => {
    const ada = await connect(mock.url, "mock-token-ada");
    try {
      const ok = await ada.callTool({ name: "log_time", arguments: { start_date: "2026-01-15", duration: 6 } });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ worker_id: ADA, status: "DRAFT", idempotency_key: `forge-${ADA}-2026-01-15`, time_entry_summary: { duration: 6 } });

      // The agent cannot choose the status or the worker: those arguments do not exist.
      for (const sneaky of [{ status: "APPROVED" }, { worker_id: GRACE }]) {
        const r = await ada.callTool({ name: "log_time", arguments: { start_date: "2026-01-16", duration: 1, ...sneaky } }).catch((e: Error) => ({ isError: true, content: e.message }));
        expect(r.isError).toBe(true);
      }
    } finally {
      await ada.close();
    }
  });

  it("only changes the owner's own drafts", { timeout: 60_000 }, async () => {
    const ada = await connect(mock.url, "mock-token-ada");
    try {
      const approved = await ada.callTool({ name: "delete_my_draft_entry", arguments: { time_entry_id: entryId(ADA, "2026-01-12") } });
      expect(approved.isError).toBe(true);
      expect(text(approved)).toContain("Refused: you can only change your own draft entries");
      const gracesEntry = await ada.callTool({ name: "update_my_draft_entry", arguments: { time_entry_id: entryId(GRACE, "2026-01-12"), duration: 9 } });
      expect(gracesEntry.isError).toBe(true);
      expect(text(gracesEntry)).toContain("HTTP 404");
    } finally {
      await ada.close();
    }
    // Even with a company-wide admin token, the tool will not touch someone else's entry.
    const admin = await connect(mock.url, "mock-token-admin");
    try {
      const r = await admin.callTool({ name: "delete_my_draft_entry", arguments: { time_entry_id: entryId(GRACE, "2026-01-12") } });

      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Refused: you can only change your own draft entries");
      const card = await admin.callTool({ name: "list_time_entries", arguments: {} });
      expect(JSON.stringify(card.structuredContent)).toContain(GRACE);
    } finally {
      await admin.close();
    }
  });
});
