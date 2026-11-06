#!/usr/bin/env node
// Stand-in for the `claude` CLI in headless mode. Records how it was called
// and answers according to FAKE_CLAUDE_MODE.
import { writeFileSync } from "node:fs";

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLAUDE_LOG) writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), simple: process.env.CLAUDE_CODE_SIMPLE ?? null }));
  const base = { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", modelUsage: { "claude-opus-5-5": {} } };
  const mode = process.env.FAKE_CLAUDE_MODE;
  let out;
  if (mode === "logged-out") out = { ...base, is_error: true, result: "Not logged in · Please run /login" };
  else if (mode === "refusal") out = { ...base, stop_reason: "refusal", result: "declined" };
  else if (mode === "text") out = { ...base, result: "Sure! Here are some ideas." };
  else if (mode === "bad-shape") out = { ...base, structured_output: { tools: "nope" } };
  else if (mode === "result-json") out = { ...base, result: process.env.FAKE_CLAUDE_ANSWER };
  else out = { ...base, result: "", structured_output: JSON.parse(process.env.FAKE_CLAUDE_ANSWER ?? "{}") };
  process.stdout.write(JSON.stringify(out));
});
