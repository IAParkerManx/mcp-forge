// `mcp-forge create`: target detection, OpenAPI discovery, and the whole
// pipeline against the demo CLI (no REA needed: help capture is real REA in
// the CLI, so here a local HTTP API exercises the URL path end to end).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectTarget, discoverGets, runCreate } from "../src/cli/create.ts";

const work = fileURLToPath(new URL("../.tmp/create/", import.meta.url));
const examples = fileURLToPath(new URL("../../../examples/targets/", import.meta.url));
let api: Server;
let base: string;
const calls: string[] = [];

beforeAll(async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  // A tiny API that publishes an OpenAPI document, like FastAPI does.
  api = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/openapi.json") {
      return send(200, {
        openapi: "3.1.0",
        info: { title: "Wildlife Survey API" },
        paths: {
          "/species": { get: {} },
          "/species/{id}": { get: {} },
          "/sightings": { get: { parameters: [{ name: "site", in: "query", required: true }] } },
          "/stats": { get: { parameters: [{ name: "year", in: "query", required: false }] } },
          "/jobs": { post: {} },
        },
      });
    }
    if (req.url === "/species") return send(200, { species: [{ id: "leo", name: "Lion" }], count: 1 });
    if (req.url === "/stats") return send(200, { surveys: 3, cameras: 42 });
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(async () => {
  api.close();
  await rm(work, { recursive: true, force: true });
});

describe("detectTarget", () => {
  it("recognizes each kind of target", () => {
    expect(detectTarget("https://api.example.com/")).toEqual({ kind: "api", location: "https://api.example.com" });
    expect(detectTarget(join(examples, "cli-demo/bin/taskr.mjs")).kind).toBe("cli");
    // The executable is found when the demo's Electron is installed (it is not in CI).
    const electronApp = detectTarget(join(examples, "electron-demo/app/main.js"));
    expect(electronApp.kind).toBe("electron");
    if (electronApp.electron) expect(electronApp.electron).toMatch(/electron/i);
    expect(detectTarget("node")).toEqual({ kind: "cli", location: "node" });
    expect(() => detectTarget("definitely-not-a-command-xyz")).toThrow(/not a URL, a file, or a command/);
    expect(() => detectTarget(examples)).toThrow(/not a Tauri or Electron app/);
  });

  it("recognizes a Tauri app by its src-tauri folder or Cargo.toml", async () => {
    const app = join(work, "tauri-app");
    await mkdir(join(app, "src-tauri/src"), { recursive: true });
    expect(detectTarget(app)).toEqual({ kind: "tauri", location: join(app, "src-tauri") });
    await writeFile(join(app, "src-tauri/Cargo.toml"), '[dependencies]\ntauri = { version = "2" }\n');
    expect(detectTarget(join(app, "src-tauri"))).toEqual({ kind: "tauri", location: join(app, "src-tauri") });
  });
});

describe("OpenAPI discovery", () => {
  it("picks GET endpoints that need no input", async () => {
    expect(await discoverGets(base)).toEqual({ paths: ["/species", "/stats"], title: "Wildlife Survey API", spec: "/openapi.json" });
  });
});

describe("runCreate", () => {
  it("builds and tests a server for an HTTP API from its URL alone", { timeout: 60_000 }, async () => {
    calls.length = 0;
    const lines: string[] = [];
    const result = await runCreate({ target: detectTarget(base), outDir: join(work, "api"), install: false, verify: true, log: (l) => lines.push(l) });
    expect(result.manifest.server.name).toBe("wildlife-survey-api-mcp");
    expect(result.manifest.tools.map((t) => t.name)).toEqual(["get_stats", "list_species"]);
    expect(result.results?.map((r) => r.status)).toEqual(["pass", "pass"]);
    // Only GETs were ever sent.
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(result.claudeCommand).toMatch(/^claude mcp add wildlife-survey-api-mcp -- node .*server\.mjs'?$/);
    expect(result.clientConfig).toEqual({ mcpServers: { "wildlife-survey-api-mcp": { command: "node", args: [join(work, "api", "server", "server.mjs")] } } });
    expect(await readFile(join(work, "api/forge.config.yaml"), "utf8")).toContain("enabled: true");
    expect(lines[0]).toMatch(/Found 2 read-only endpoint\(s\)/);
  });

  it("carries -e environment into the client config", { timeout: 60_000 }, async () => {
    const result = await runCreate({ target: detectTarget(base), outDir: join(work, "api2"), env: { WILDLIFE_TOKEN_FILE: "/tmp/t" }, install: false, verify: false });
    expect(result.claudeCommand).toContain("-e WILDLIFE_TOKEN_FILE=/tmp/t");
    expect(result.clientConfig).toMatchObject({ mcpServers: { "wildlife-survey-api-mcp": { env: { WILDLIFE_TOKEN_FILE: "/tmp/t" } } } });
  });

  it("explains what to do when an API publishes no OpenAPI document", async () => {
    const plain = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(plain.address() as { port: number }).port}`;
      await expect(runCreate({ target: detectTarget(url), outDir: join(work, "none"), install: false })).rejects.toThrow(/--get \/path/);
    } finally {
      plain.close();
    }
  });
});
