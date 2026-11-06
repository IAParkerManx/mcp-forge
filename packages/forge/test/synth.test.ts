import { describe, expect, it } from "vitest";
import { inferSchema, inferScalarFromStrings } from "../src/synth/schema.ts";
import { classifyHttpEffects, detectPagination, nameHttpOperation } from "../src/synth/heuristics.ts";
import { collectSecrets, redact, REDACTED } from "../src/synth/redact.ts";

describe("inferSchema", () => {
  it("marks only always-present properties as required", () => {
    const schema = inferSchema([
      { title: "a", body: "x" },
      { title: "b", pinned: true },
    ]);
    expect(schema.required).toEqual(["title"]);
    expect(Object.keys(schema.properties as object)).toEqual(["body", "pinned", "title"]);
  });

  it("makes everything optional for PATCH-style bodies", () => {
    expect(inferSchema([{ title: "a" }], { allOptional: true }).required).toBeUndefined();
  });

  it("detects formats and nullable scalars", () => {
    const schema = inferSchema([
      { id: "df9de26f-ad44-44bc-ad48-49399bd2aa49", at: "2026-01-01T00:00:00.000Z", next: null },
      { id: "ea503d89-2f34-4029-a079-b79d21a57e4a", at: "2026-01-02T00:00:00Z", next: "3" },
    ]);
    const p = schema.properties as Record<string, Record<string, unknown>>;
    expect(p.id).toEqual({ type: "string", format: "uuid" });
    expect(p.at).toEqual({ type: "string", format: "date-time" });
    expect(p.next!.type).toEqual(["string", "null"]);
  });

  it("does not pin a field to null just because only null was seen", () => {
    expect(inferSchema([{ key: null }, { key: null }])).toEqual({ type: "object", properties: { key: { description: "Only null was observed; the type is unknown." } }, required: ["key"] });
  });

  it("widens integer to number and merges array items", () => {
    const schema = inferSchema([[{ n: 1 }, { n: 1.5 }]]);
    expect(schema).toEqual({ type: "array", items: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });
  });

  it("falls back to anyOf for mixed structured types", () => {
    expect(inferSchema([{ a: 1 }, [1]]).anyOf).toHaveLength(2);
  });
});

describe("inferScalarFromStrings", () => {
  it("types numeric query values but keeps cursors opaque", () => {
    expect(inferScalarFromStrings(["3", "5"], "limit")).toEqual({ type: "integer" });
    expect(inferScalarFromStrings(["3", "6"], "cursor")).toEqual({ type: "string" });
  });
});

describe("naming and effects", () => {
  it.each([
    ["GET", "/api/notes", true, "list_notes"],
    ["GET", "/api/notes/{note_id}", false, "get_note"],
    ["GET", "/api/me", false, "get_me"],
    ["POST", "/api/notes", false, "create_note"],
    ["PATCH", "/api/notes/{note_id}", false, "update_note"],
    ["DELETE", "/api/notes/{note_id}", false, "delete_note"],
    ["GET", "/api/v2/search", true, "search"],
    ["POST", "/api/notes/{note_id}/archive", false, "archive_note"],
    ["GET", "/api/categories", true, "list_categories"],
    ["GET", "/list-detectors", false, "list_detectors"],
    ["POST", "/run-analysis", false, "run_analysis"],
    ["POST", "/stop", false, "stop"],
    ["GET", "/describe-survey", false, "describe_survey"],
    ["POST", "/jobs/stop", false, "stop_jobs"],
  ])("%s %s → %s", (method, path, collection, expected) => {
    expect(nameHttpOperation(method, path, collection)).toBe(expected);
  });

  it("classifies effects by method, treating POST search as read", () => {
    expect(classifyHttpEffects("DELETE", "/x/{id}")).toEqual({ effects: "destructive", idempotent: true });
    expect(classifyHttpEffects("POST", "/api/search")).toEqual({ effects: "read", idempotent: true });
    expect(classifyHttpEffects("POST", "/api/notes").effects).toBe("write");
  });

  it("pairs a cursor param with a next-cursor response field", () => {
    const output = { type: "object", properties: { items: {}, next_cursor: {} } };
    expect(detectPagination(["cursor", "limit"], output)).toEqual({ style: "cursor", request_param: "cursor", response_field: "next_cursor" });
    expect(detectPagination(["limit"], output)).toBeUndefined();
  });
});

describe("redact", () => {
  it("treats auth fields as secret but not author fields", () => {
    expect(redact({ auth: "abcd1234", auth_token: "abcd1234", authorization: "Bearer x", author_id: "6569930dfb7bc7c3510f5bac", authored_by: "Ada" })).toEqual({
      auth: REDACTED,
      auth_token: REDACTED,
      authorization: REDACTED,
      author_id: "6569930dfb7bc7c3510f5bac",
      authored_by: "Ada",
    });
  });

  it("redacts secret-keyed values and known literals anywhere", () => {
    const secrets = collectSecrets({ csrf_token: "abcdef123456" });
    const out = redact({ password: "hunter22", note: "token is abcdef123456", nested: [{ apiKey: "k-1234" }] }, secrets);
    expect(out).toEqual({ password: REDACTED, note: `token is ${REDACTED}`, nested: [{ apiKey: REDACTED }] });
  });
});
