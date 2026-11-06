import { beforeAll, describe, expect, it } from "vitest";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWeb, templatePath } from "../src/extract/har.ts";
import { draftConfig, resolveTools } from "../src/curate/config.ts";
import type { ForgeIR } from "../src/ir/types.ts";
import { evidenceFromHar } from "./helpers.ts";
// @ts-expect-error untyped example module
import { recordHar } from "../../../examples/targets/web-demo/record-har.mjs";

let ir: ForgeIR;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-extract-"));
  const harPath = await recordHar(join(dir, "demo.har"));
  ir = extractWeb(evidenceFromHar(JSON.parse(await readFile(harPath, "utf8"))), { targetName: "web-demo", reaVersion: "test" });
});

describe("templatePath", () => {
  it("names id segments after their collection", () => {
    expect(templatePath(["api", "notes", "df9de26f-ad44-44bc-ad48-49399bd2aa49"]).template).toBe("/api/notes/{note_id}");
    expect(templatePath(["users", "42", "posts", "7"]).template).toBe("/users/{user_id}/posts/{post_id}");
  });
});

describe("extractWeb on the demo capture", () => {
  it("finds every API operation and models login as auth", () => {
    expect(ir.operations.map((o) => o.name)).toEqual(["create_note", "delete_note", "get_me", "get_note", "list_notes", "list_tags", "search", "update_note"]);
    expect(ir.auth).toMatchObject({
      kind: "cookie-session",
      login_request: { method: "POST", path: "/api/login" },
      credential_fields: ["username", "password"],
      csrf: { header: "x-csrf-token", source_method: "GET", source_path: "/api/me", source_pointer: "/csrf_token" },
    });
  });

  it("infers inputs, outputs and pagination", () => {
    const list = ir.operations.find((o) => o.name === "list_notes")!;
    expect(Object.keys(list.input.properties as object)).toEqual(["cursor", "limit", "tag"]);
    expect(list.pagination).toEqual({ style: "cursor", request_param: "cursor", response_field: "next_cursor" });
    const create = ir.operations.find((o) => o.name === "create_note")!;
    expect(create.input.required).toEqual(["tags", "title"]);
    const update = ir.operations.find((o) => o.name === "update_note")!;
    expect(update.input.required).toEqual(["note_id"]);
    expect(ir.operations.find((o) => o.name === "list_tags")!.output_wrapped_as).toBe("items");
    expect(ir.operations.find((o) => o.name === "delete_note")!.output).toBeUndefined();
  });

  it("never stores secrets in fixtures and records argument provenance", () => {
    const text = JSON.stringify(ir);
    expect(text).not.toContain("demo-password");
    const del = ir.fixtures.find((f) => f.operation_id === "delete_api_notes_note_id")!;
    const created = ir.fixtures.find((f) => f.operation_id === "post_api_notes")!;
    expect(del.derived).toEqual([expect.objectContaining({ argument: "note_id", pointer: "/id" })]);
    expect(del.derived[0]!.from_ordinal).toBeGreaterThanOrEqual(created.ordinal);
  });

  it("drafts a config with write tools disabled", () => {
    const config = draftConfig(ir);
    const enabled = resolveTools(ir, config).map((t) => t.config.name);
    expect(enabled).toEqual(["get_me", "get_note", "list_notes", "list_tags", "search"]);
    expect(config.auth.login_credentials_env).toEqual({ username: "WEB_DEMO_USERNAME", password: "WEB_DEMO_PASSWORD" });
  });

  it("rejects configs that reference unknown operations or reuse names", () => {
    const config = draftConfig(ir);
    expect(() => resolveTools(ir, { ...config, tools: { ...config.tools, nope: { enabled: true, name: "x" } } })).toThrow(/unknown operation/);
    const dup = structuredClone(config);
    dup.tools["get_api_tags"]!.name = "get_me";
    expect(() => resolveTools(ir, dup)).toThrow(/duplicate/);
  });
});
