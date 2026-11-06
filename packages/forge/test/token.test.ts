// Token (Bearer / API-key) auth end to end against local APIs that require it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordHar, tokenHeader } from "../src/investigate/record.ts";
import { extractWeb } from "../src/extract/har.ts";
import { draftConfig } from "../src/curate/config.ts";
import { generateServer } from "../src/codegen/generate.ts";
import { verifyServer } from "../src/verify/replay.ts";
import { runCreate, detectTarget } from "../src/cli/create.ts";
import { evidenceFromHar } from "./helpers.ts";

const TOKEN = "tok-live-9f8e7d6c5b4a";
const work = fileURLToPath(new URL("../.tmp/token/", import.meta.url));
let bearer: Server;
let apiKey: Server;
let bearerUrl: string;
let apiKeyUrl: string;

function api(check: (h: Record<string, string | string[] | undefined>) => boolean): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/openapi.json") return send(200, { openapi: "3.1.0", info: { title: "People API" }, paths: { "/workers": { get: {} }, "/me": { get: {} } } });
    if (!check(req.headers)) return send(401, { error: "unauthorized" });
    if (req.url === "/workers") return send(200, { results: [{ id: "w1", name: "Ada", department: "Research" }], next: null });
    if (req.url === "/me") return send(200, { id: "u1", role: "viewer" });
    send(404, { error: "not found" });
  });
}

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

/** Every file under a directory, as text, to prove the token was never written. */
async function allText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && !e.parentPath.includes("node_modules")) out += await readFile(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

beforeAll(async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  bearer = api((h) => h.authorization === `Bearer ${TOKEN}`);
  apiKey = api((h) => h["x-api-key"] === TOKEN);
  bearerUrl = await listen(bearer);
  apiKeyUrl = await listen(apiKey);
  process.env.PEOPLE_API_TOKEN = TOKEN;
});
afterAll(async () => {
  bearer.close();
  apiKey.close();
  delete process.env.PEOPLE_API_TOKEN;
  await rm(work, { recursive: true, force: true });
});

describe("recording with a token", () => {
  it("sends the token but writes only the scheme to the HAR", async () => {
    const out = join(work, "people.har");
    await recordHar({ baseUrl: bearerUrl, requests: [{ method: "GET", path: "/workers" }], out, secretHeaders: await tokenHeader({ env: "PEOPLE_API_TOKEN" }) });
    const har = await readFile(out, "utf8");
    expect(har).not.toContain(TOKEN);
    expect(har).toContain('"value": "Bearer [REDACTED]"');
    expect(JSON.parse(har).log.entries[0].response.status).toBe(200);
  });

  it("explains a missing token source", async () => {
    await expect(tokenHeader({ env: "NOT_SET_ANYWHERE_123" })).rejects.toThrow(/NOT_SET_ANYWHERE_123 is not set/);
  });
});

describe("token auth in generated servers", () => {
  it("is detected from a browser HAR where the value is hidden, assuming Bearer", async () => {
    const har = { log: { entries: [{ request: { method: "GET", url: `${bearerUrl}/me`, headers: [{ name: "Authorization", value: "Bearer x" }] }, response: { status: 200, headers: [], content: { mimeType: "application/json", text: '{"id":"u1"}' } } }] } };
    const ir = extractWeb(evidenceFromHar(har as never), { targetName: "people", reaVersion: "test" });
    expect(ir.auth).toMatchObject({ kind: "token", token: { header: "authorization", scheme: "Bearer", scheme_observed: false } });
    expect(ir.notes.join(" ")).toMatch(/Bearer is assumed/);
    expect(ir.operations[0]!.auth).toBe("session");
  });

  it("builds, tests and prints a Bearer-token server without writing the token anywhere", { timeout: 60_000 }, async () => {
    const result = await runCreate({ target: detectTarget(bearerUrl), outDir: join(work, "bearer"), token: { env: "PEOPLE_API_TOKEN" }, install: false, verify: true });
    expect(result.ir.auth).toMatchObject({ kind: "token", token: { scheme: "Bearer", scheme_observed: true, env_hint: "PEOPLE_API_TOKEN" } });
    expect(result.results?.map((r) => [r.tool, r.status])).toEqual([
      ["get_me", "pass"],
      ["list_workers", "pass"],
    ]);
    expect(result.claudeCommand).toContain("-e 'PEOPLE_API_TOKEN=<your API token>'");
    expect(await allText(join(work, "bearer"))).not.toContain(TOKEN);
  });

  it("reads the token from a file, for raw API-key headers too", { timeout: 60_000 }, async () => {
    const file = join(work, "key.txt");
    await writeFile(file, `${TOKEN}\n`);
    const result = await runCreate({ target: detectTarget(apiKeyUrl), outDir: join(work, "apikey"), token: { file, header: "x-api-key", scheme: "" }, install: false, verify: true });
    expect(result.ir.auth.token).toMatchObject({ header: "x-api-key", scheme: "" });
    expect(result.results?.every((r) => r.status === "pass")).toBe(true);
    expect(result.clientConfig).toMatchObject({ mcpServers: { "people-api-mcp": { env: { PEOPLE_API_TOKEN_FILE: file } } } });
    expect(await allText(join(work, "apikey"))).not.toContain(TOKEN);
  });

  it("tells the user which variable to set when the token is missing", { timeout: 60_000 }, async () => {
    const har = JSON.parse(await readFile(join(work, "people.har"), "utf8"));
    const ir = extractWeb(evidenceFromHar(har), { targetName: "people", reaVersion: "test" });
    const manifest = await generateServer(ir, draftConfig(ir), join(work, "missing"));
    const results = await verifyServer(ir, manifest, { serverDir: join(work, "missing"), env: { PEOPLE_BASE_URL: bearerUrl } });
    expect(results[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("Set PEOPLE_TOKEN to your API token (or PEOPLE_TOKEN_FILE to a file containing it)") });
  });
});
