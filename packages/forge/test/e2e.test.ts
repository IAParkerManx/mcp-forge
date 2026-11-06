// End-to-end without network or REA: record the demo app, extract, generate
// a server, start it over stdio and replay every tool against the live app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { extractWeb } from "../src/extract/har.ts";
import { draftConfig } from "../src/curate/config.ts";
import { generateServer, stripSecretOutputs } from "../src/codegen/generate.ts";
import { saveEvidence } from "../src/rea/client.ts";
import { captureSecrets, toObservations } from "../src/extract/har.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyServer } from "../src/verify/replay.ts";
import { evidenceFromHar } from "./helpers.ts";
// @ts-expect-error untyped example module
import { recordHar } from "../../../examples/targets/web-demo/record-har.mjs";
// @ts-expect-error untyped example module
import { createApp } from "../../../examples/targets/web-demo/server.mjs";

// Inside the workspace so the generated server resolves @modelcontextprotocol/server.
const work = fileURLToPath(new URL("../.tmp/e2e/", import.meta.url));
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

describe("web pipeline", () => {
  it("generates a server whose tools replay against the live target", { timeout: 60_000 }, async () => {
    const har = JSON.parse(await readFile(await recordHar(join(work, "demo.har")), "utf8"));
    const ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
    const config = draftConfig(ir);
    for (const tool of Object.values(config.tools)) tool.enabled = true;
    const manifest = await generateServer(ir, config, join(work, "server"));
    expect(manifest.tools).toHaveLength(8);

    const env = { WEB_DEMO_BASE_URL: baseUrl, WEB_DEMO_USERNAME: "demo", WEB_DEMO_PASSWORD: "demo-password" };
    const results = await verifyServer(ir, manifest, { serverDir: join(work, "server"), env, includeWrites: true });
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
  });

  it("reports a clear error when no credentials are configured", { timeout: 60_000 }, async () => {
    const har = JSON.parse(await readFile(await recordHar(join(work, "demo2.har")), "utf8"));
    const ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
    const manifest = await generateServer(ir, draftConfig(ir), join(work, "server2"));
    const results = await verifyServer(ir, manifest, { serverDir: join(work, "server2"), env: { WEB_DEMO_BASE_URL: baseUrl } });
    const me = results.find((r) => r.tool === "get_me")!;
    expect(me.status).toBe("fail");
    expect(me.detail).toMatch(/WEB_DEMO_COOKIE or WEB_DEMO_USERNAME \+ WEB_DEMO_PASSWORD/);
  });

  it("works with a pasted session cookie, fetching the CSRF token itself", { timeout: 60_000 }, async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password: "demo-password" }),
    });
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const har = JSON.parse(await readFile(await recordHar(join(work, "demo3.har")), "utf8"));
    const ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
    const config = draftConfig(ir);
    for (const tool of Object.values(config.tools)) tool.enabled = true;
    const manifest = await generateServer(ir, config, join(work, "server3"));
    const results = await verifyServer(ir, manifest, {
      serverDir: join(work, "server3"),
      env: { WEB_DEMO_BASE_URL: baseUrl, WEB_DEMO_COOKIE: cookie },
      includeWrites: true,
    });
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
  });

  it("keeps session secrets out of tool outputs", { timeout: 60_000 }, async () => {
    const har = JSON.parse(await readFile(await recordHar(join(work, "demo4.har")), "utf8"));
    const ir = extractWeb(evidenceFromHar(har), { targetName: "web-demo", reaVersion: "test" });
    const me = stripSecretOutputs(ir.operations.find((o) => o.name === "get_me")!);
    expect(me.omit).toEqual(["csrf_token"]);
    expect(Object.keys(me.op.output!.properties as object)).toEqual(["username"]);
    // Pagination cursors are not secrets.
    expect(stripSecretOutputs(ir.operations.find((o) => o.name === "list_notes")!).omit).toEqual([]);

    await generateServer(ir, draftConfig(ir), join(work, "server4"));
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(work, "server4", "server.mjs")],
        env: { PATH: process.env.PATH ?? "", WEB_DEMO_BASE_URL: baseUrl, WEB_DEMO_USERNAME: "demo", WEB_DEMO_PASSWORD: "demo-password" },
        stderr: "pipe",
      }),
    );
    try {
      const res = await client.callTool({ name: "get_me", arguments: {} });
      expect(res.structuredContent).toEqual({ username: "demo" });
      expect(JSON.stringify(res.content)).not.toContain("csrf");
    } finally {
      await client.close();
    }
  });

  it("saves REA Evidence with captured secrets replaced and REA field names intact", async () => {
    const har = JSON.parse(await readFile(await recordHar(join(work, "demo5.har")), "utf8"));
    const evidence = evidenceFromHar(har);
    (evidence.normalized_result as Record<string, unknown>).api_key = "structural-name";
    const path = await saveEvidence(join(work, "evidence"), evidence, captureSecrets(toObservations(evidence)));
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain("demo-password");
    expect(saved).toContain('"api_key": "structural-name"');
    expect(saved).toContain("[REDACTED]");
  });
});
