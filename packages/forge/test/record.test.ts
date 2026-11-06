import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest, recordHar } from "../src/investigate/record.ts";

let server: Server;
let base: string;
const seen: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("forge record", () => {
  it("parses request lines", () => {
    expect(parseRequest("/health")).toEqual({ method: "GET", path: "/health" });
    expect(parseRequest('post /run {"a":1}')).toEqual({ method: "POST", path: "/run", body: { a: 1 } });
    expect(() => parseRequest("POST /run {oops}")).toThrow(/JSON/);
  });

  it("records GETs to a HAR and refuses writes without opt-in", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "forge-record-")), "api.har");
    await recordHar({ baseUrl: base, requests: [parseRequest("/health"), parseRequest("GET /status?limit=2")], out });
    const har = JSON.parse(await readFile(out, "utf8"));
    expect(har.log.entries.map((e: { request: { url: string } }) => new URL(e.request.url).pathname + new URL(e.request.url).search)).toEqual(["/health", "/status?limit=2"]);
    await expect(recordHar({ baseUrl: base, requests: [parseRequest("POST /run {}")], out })).rejects.toThrow(/--allow-writes/);
    await expect(recordHar({ baseUrl: base, requests: [parseRequest("//evil.example/x")], out })).rejects.toThrow(/leaves/);
    expect(seen).toEqual(["GET /health", "GET /status?limit=2"]);
  });
});
