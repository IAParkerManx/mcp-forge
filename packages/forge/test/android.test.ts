// Shelved Android work: the manifest reader and the adb runtime helpers are
// tested here; the investigation step that feeds them is not built yet.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseManifest, readExtras, readTables, readUriPatterns } from "../src/extract/android.ts";
// @ts-expect-error untyped runtime module
import { deviceCommand, parseRows, shellQuote } from "../templates/server/lib/adb-runtime.mjs";

describe("android manifest and code readers", () => {
  it("reads exported components from the demo manifest", async () => {
    const xml = await readFile(new URL("../../../examples/targets/android-demo/AndroidManifest.xml", import.meta.url), "utf8");
    const m = parseManifest(xml);
    expect(m.package).toBe("com.example.pocketnotes");
    expect(m.components.map((c) => [c.type, c.name.split(".").at(-1), c.exported])).toEqual([
      ["activity", "MainActivity", true],
      ["activity", "AddNoteActivity", true],
      ["activity", "SettingsActivity", false],
      ["provider", "NotesProvider", true],
    ]);
    expect(m.components[0]!.filters[1]!.data).toEqual([{ scheme: "pocketnotes", host: "note" }]);
    expect(m.components[3]!.authorities).toEqual(["com.example.pocketnotes.provider"]);
  });

  it("reads extras, UriMatcher paths and table columns from source text", () => {
    expect(readExtras('getIntent().getStringExtra("title"); getBooleanExtra("pinned", false); getStringExtra("title")')).toEqual([
      { key: "title", type: "s" },
      { key: "pinned", type: "z" },
    ]);
    expect(readUriPatterns('m.addURI(AUTHORITY, "notes", 1); m.addURI(AUTHORITY, "notes/#", 2);')).toEqual(["notes", "notes/#"]);
    const [table] = readTables('db.execSQL("CREATE TABLE notes (_id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT)");');
    expect(table!.columns.map((c) => [c.name, c.sqlType, c.notNull, c.primaryKey])).toEqual([
      ["_id", "INTEGER", false, true],
      ["title", "TEXT", true, false],
      ["body", "TEXT", false, false],
    ]);
  });
});

describe("adb runtime helpers", () => {
  it("quotes every argument for the device shell", () => {
    expect(shellQuote("it's; rm -rf /")).toBe(`'it'\\''s; rm -rf /'`);
  });

  it("builds provider and activity commands and validates ids", () => {
    const provider = { op: "provider-insert", uri_template: "content://a.b/notes", binds: [{ name: "title", column: "title", type: "s" }], columns: [] };
    expect(deviceCommand(provider, { title: "Buy milk" })).toEqual(["content", "insert", "--uri", "content://a.b/notes", "--bind", "title:s:Buy milk"]);
    expect(() => deviceCommand({ op: "provider-delete", uri_template: "content://a.b/notes/{note_id}", binds: [], columns: [] }, { note_id: "1 OR 1=1" })).toThrow(/integer/);
    const activity = { op: "activity", component: "a.b/.Add", extras: [{ name: "title", key: "title", type: "s" }, { name: "pinned", key: "pinned", type: "z" }] };
    expect(deviceCommand(activity, { title: "x", pinned: true })).toEqual(["am", "start", "-W", "-n", "a.b/.Add", "--es", "title", "x", "--ez", "pinned", "true"]);
  });

  it("parses content query rows with known columns", () => {
    const rows = parseRows("Row: 0 _id=2, title=Call mom, later, body=, pinned=0\nRow: 1 _id=1, title=Buy milk, body=NULL, pinned=1\n", [
      { name: "_id", type: "integer" },
      { name: "title", type: "string" },
      { name: "body", type: "string" },
      { name: "pinned", type: "integer" },
    ]);
    expect(rows).toEqual([
      { _id: 2, title: "Call mom, later", body: "", pinned: 0 },
      { _id: 1, title: "Buy milk", body: null, pinned: 1 },
    ]);
  });
});
