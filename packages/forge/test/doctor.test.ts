import { describe, expect, it } from "vitest";
import { formatDoctor, runDoctor, type Exec } from "../src/cli/doctor.ts";

/** A stand-in for running commands: map "command args" to results. */
function fakeExec(results: Record<string, { ok: boolean; stdout?: string; stderr?: string }>): Exec {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const hit = Object.entries(results).find(([prefix]) => key.startsWith(prefix))?.[1];
    return { ok: hit?.ok ?? false, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "not found" };
  };
}

const healthy = {
  "npm --version": { ok: true, stdout: "11.0.0\n" },
  "npx -y rea-agents": { ok: true, stdout: "6.4.0\n" },
  "xcrun --find swift": { ok: true, stdout: "/usr/bin/swift\n" },
  "docker version": { ok: true, stdout: "29.0.0\n" },
  "claude auth status": { ok: true, stdout: '{"loggedIn": true}' },
};

describe("doctor", () => {
  it("reports a ready machine", async () => {
    const checks = await runDoctor({ exec: fakeExec(healthy), platform: "darwin", nodeVersion: "24.11.0", env: {} });
    expect(checks.filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(formatDoctor(checks)).toMatch(/Ready\.$/);
  });

  it("explains each problem with a fix", async () => {
    const checks = await runDoctor({
      exec: fakeExec({ "npm --version": { ok: true, stdout: "10.0.0" }, "docker version": { ok: false, stderr: "Cannot connect to the Docker daemon" } }),
      platform: "darwin",
      nodeVersion: "20.11.0",
      env: {},
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["Node.js"]).toMatchObject({ status: "fail", fix: expect.stringContaining("Node.js 24") });
    expect(byName["REA 6.4.0"]).toMatchObject({ status: "fail", fix: expect.stringContaining("npx -y rea-agents@6.4.0") });
    expect(byName["Swift (for REA process capture)"]).toMatchObject({ status: "fail", fix: "Install Apple's Command Line Tools: xcode-select --install" });
    expect(byName["Docker (Tauri targets run read-only docker commands)"]).toMatchObject({ status: "warn", detail: "docker is installed but the engine is not running" });
    expect(checks.find((c) => c.area === "llm")).toMatchObject({ status: "warn" });
    expect(formatDoctor(checks)).toMatch(/3 problem\(s\) to fix, 2 warning\(s\)\.$/);
  });

  it("checks only the requested target kinds, per platform", async () => {
    const linux = await runDoctor({ areas: ["cli"], exec: fakeExec({ ...healthy, "ps --version": { ok: true, stdout: "ps from procps-ng 4.0.4" } }), platform: "linux", nodeVersion: "22.19.0", env: {} });
    expect(linux.map((c) => c.area)).toEqual(["general", "general", "general", "cli"]);
    expect(linux.at(-1)).toMatchObject({ status: "ok" });
    const windows = await runDoctor({ areas: ["cli"], exec: fakeExec(healthy), platform: "win32", nodeVersion: "24.0.0", env: {} });
    expect(windows.at(-1)).toMatchObject({ status: "fail", fix: "Run mcp-forge inside WSL for command-line targets." });
    const keyed = await runDoctor({ areas: ["llm"], exec: fakeExec(healthy), platform: "darwin", nodeVersion: "24.0.0", env: { ANTHROPIC_API_KEY: "x" } });
    expect(keyed.at(-1)).toMatchObject({ status: "ok", detail: "Anthropic API credential found in the environment" });
  });
});
