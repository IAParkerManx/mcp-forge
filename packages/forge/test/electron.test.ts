// Electron: extraction from a trimmed copy of REA's real analysis of the demo
// app, and an end-to-end run that launches the demo app (hidden) when the
// Electron binary is installed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeMembers, classifyElectronEffects, extractElectron, membersFromSource, parseParams, type SampleCall } from "../src/extract/electron.ts";
import { parseCall } from "../src/investigate/electron.ts";
import { installedElectron } from "../src/cli/create.ts";
import { draftConfig } from "../src/curate/config.ts";
import { generateServer } from "../src/codegen/generate.ts";
import { verifyServer } from "../src/verify/replay.ts";
import type { ReaEvidence } from "../src/rea/client.ts";
// @ts-expect-error untyped runtime module
import { callExpression, createElectronRuntime } from "../templates/server/lib/electron-runtime.mjs";

const APP_ROOT = fileURLToPath(new URL("../../../examples/targets/electron-demo/app/", import.meta.url));
const APP = join(APP_ROOT, "main.js");
const work = fileURLToPath(new URL("../.tmp/electron/", import.meta.url));
let evidence: ReaEvidence;
let electron: string | undefined;

beforeAll(async () => {
  evidence = JSON.parse(await readFile(new URL("./fixtures/electron-demo-analysis.json", import.meta.url), "utf8"));
  // Never require("electron") here: that downloads the binary when it is missing (as in CI).
  electron = installedElectron(fileURLToPath(new URL("../../../examples/targets/electron-demo/", import.meta.url)));
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
});
afterAll(() => rm(work, { recursive: true, force: true }));

describe("reading preload members", () => {
  it("parses parameter lists", () => {
    expect(parseParams("id, { force } = {}, ...rest")).toEqual({ params: ["id", "arg2"], rest: "rest" });
    expect(parseParams("")).toEqual({ params: [] });
    expect(parseParams("noteId, opts = {}")).toEqual({ params: ["note_id", "opts"] });
  });

  it("finds arrow, function and method members", () => {
    const src = [
      'contextBridge.exposeInMainWorld("api", {',
      "  a: (x, y) => ipcRenderer.invoke('a', x, y),",
      "  b: async function (z) { return 1; },",
      "  c(w) { return ipcRenderer.send('c', w); },",
      "  d: q => q,",
      "});",
    ].join("\n");
    const found = membersFromSource(src, 1, 6, ["a", "b", "c", "d", "missing"]);
    expect(Object.fromEntries([...found].map(([k, v]) => [k, v.params]))).toEqual({ a: ["x", "y"], b: ["z"], c: ["w"], d: ["q"] });
  });

  it("classifies effects from member and channel words", () => {
    expect(classifyElectronEffects("deleteNote").effects).toBe("destructive");
    expect(classifyElectronEffects("appInfo", "app:info").effects).toBe("read");
    expect(classifyElectronEffects("setTitle").effects).toBe("write");
    expect(classifyElectronEffects("frob", "x:frob").effects).toBe("unknown");
    expect(classifyElectronEffects("refresh", "cache:clear").effects).toBe("destructive");
  });

  it("pairs each member with its channel and handler from REA's graph", async () => {
    const { members } = await bridgeMembers(evidence, APP_ROOT);
    expect(members.map((m) => [m.member, m.params, m.channel, m.ipc_mode, m.handler?.start])).toEqual([
      ["listNotes", ["folder"], "notes:list", "invoke", 14],
      ["getNote", ["id"], "notes:get", "invoke", 18],
      ["createNote", ["note"], "notes:create", "invoke", 19],
      ["deleteNote", ["id"], "notes:delete", "invoke", 28],
      ["appInfo", [], "app:info", "invoke", 35],
      ["setTitle", ["title"], "window:set-title", "send", 36],
    ]);
  });
});

describe("calling the page", () => {
  it("passes arguments as JSON data, never as code", () => {
    const expr = callExpression({ api: "desknotes", member: "getNote", params: ["id"] }, { id: '"); process.exit(1); ("' });
    expect(expr).toContain('api["getNote"](...["\\"); process.exit(1); (\\""])');
    expect(callExpression({ api: "a", member: "m", params: ["x", "y"] }, { x: 1 })).toContain("(...[1])");
  });

  it("parses --call arguments as JSON only", () => {
    expect(parseCall('desknotes.listNotes("work", 2)')).toEqual({ api: "desknotes", member: "listNotes", args: ["work", 2] });
    expect(() => parseCall("desknotes.listNotes(process.exit())")).toThrow(/must be JSON/);
  });

  it("refuses non-loopback debugging endpoints", async () => {
    const runtime = createElectronRuntime({ server: { cdp_url_env: "X" } }, { X: "http://example.com:9222" });
    await expect(runtime.invoke({ binding: { api: "a", member: "b", params: [] } }, {})).rejects.toThrow(/loopback/);
  });
});

describe("demo app end to end", () => {
  it("extracts, generates and replays against the running app", { timeout: 120_000 }, async (ctx) => {
    if (!electron) ctx.skip();
    const env = { ...process.env, DESKNOTES_HIDDEN: "1", DESKNOTES_DATA: join(work, "investigate.json") } as Record<string, string>;
    // Sample calls through the same runtime the generated server uses.
    const runtime = createElectronRuntime({ server: { electron_env: "E", default_electron: electron, default_app: APP } }, env);
    const texts = ['desknotes.listNotes()', 'desknotes.createNote({"title":"Buy milk","folder":"work"})', 'desknotes.listNotes("work")'];
    const calls: SampleCall[] = [];
    try {
      for (const [ordinal, text] of texts.entries()) {
        const { api, member, args } = parseCall(text);
        const out = await runtime.invoke({ binding: { api, member, params: args.map((_, i) => `a${i}`) } }, Object.fromEntries(args.map((a, i) => [`a${i}`, a])));
        calls.push({ ordinal, api, member, args, ...out });
      }
      const created = calls[1]!.value as { id: string };
      const out = await runtime.invoke({ binding: { api: "desknotes", member: "deleteNote", params: ["id"] } }, { id: created.id });
      calls.push({ ordinal: 3, api: "desknotes", member: "deleteNote", args: [created.id], ...out });
    } finally {
      runtime.close();
    }
    expect(calls.every((c) => c.ok)).toBe(true);

    const ir = await extractElectron({ targetName: "desknotes", reaVersion: "test", appRoot: APP_ROOT, appPath: APP, electronExecutable: electron!, staticEvidence: evidence, calls });
    // The most recent earlier response that contained the id: listNotes("work").
    expect(ir.fixtures.find((f) => f.ordinal === 3)!.derived).toEqual([{ argument: "id", from_ordinal: 2, pointer: "/notes/0/id" }]);
    const list = ir.operations.find((o) => o.name === "desknotes_list_notes")!;
    expect(list.input.required).toBeUndefined();
    expect(Object.keys((list.output as { properties: object }).properties)).toEqual(["count", "notes"]);

    const config = draftConfig(ir);
    expect(config.server).toMatchObject({ cdp_url_env: "DESKNOTES_CDP_URL", electron_env: "DESKNOTES_ELECTRON", default_app: APP });
    for (const t of Object.values(config.tools)) t.enabled = true;
    const manifest = await generateServer(ir, config, join(work, "server"));
    const results = await verifyServer(ir, manifest, {
      serverDir: join(work, "server"),
      env: { DESKNOTES_HIDDEN: "1", DESKNOTES_DATA: join(work, "verify.json"), HOME: process.env.HOME ?? "" },
      includeWrites: true,
    });
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.filter((r) => r.status === "pass").map((r) => r.tool)).toEqual(["desknotes_create_note", "desknotes_delete_note", "desknotes_list_notes"]);
  });
});
