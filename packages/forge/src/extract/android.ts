// Android extractor: REA's decoded manifest and decompiled methods → IR.
// Exported content providers become query/get/insert/update/delete tools;
// exported activities become "open" tools with the extras their code reads.
// Everything is driven over adb by the generated server.
import type { AdbBinding, EvidenceRef, Fixture, ForgeIR, JsonSchema, Operation } from "../ir/types.ts";
import { humanize, singular, snake } from "../synth/heuristics.ts";

// ---- manifest ---------------------------------------------------------------

export interface IntentFilter {
  actions: string[];
  categories: string[];
  data: { scheme?: string; host?: string; path?: string; pathPrefix?: string }[];
}

export interface ManifestComponent {
  type: "activity" | "activity-alias" | "service" | "receiver" | "provider";
  name: string;
  exported: boolean;
  permission?: string;
  authorities?: string[];
  filters: IntentFilter[];
}

export interface Manifest {
  package: string;
  components: ManifestComponent[];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** Read components and intent filters from REA's decoded AndroidManifest.xml text. */
export function parseManifest(xml: string): Manifest {
  const pkg = /<manifest\b[^>]*\bpackage="([^"]+)"/.exec(xml)?.[1] ?? "";
  const components: ManifestComponent[] = [];
  const re = /<(activity-alias|activity|service|receiver|provider)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(re)) {
    const type = m[1] as ManifestComponent["type"];
    const a = attrs(m[2]!);
    const body = m[4] ?? "";
    const filters: IntentFilter[] = [];
    for (const f of body.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g)) {
      const inner = f[1]!;
      filters.push({
        actions: [...inner.matchAll(/<action\b([^>]*)\/?>/g)].map((x) => attrs(x[1]!)["android:name"]!).filter(Boolean),
        categories: [...inner.matchAll(/<category\b([^>]*)\/?>/g)].map((x) => attrs(x[1]!)["android:name"]!).filter(Boolean),
        data: [...inner.matchAll(/<data\b([^>]*)\/?>/g)].map((x) => {
          const d = attrs(x[1]!);
          return {
            ...(d["android:scheme"] ? { scheme: d["android:scheme"] } : {}),
            ...(d["android:host"] ? { host: d["android:host"] } : {}),
            ...(d["android:path"] ? { path: d["android:path"] } : {}),
            ...(d["android:pathPrefix"] ? { pathPrefix: d["android:pathPrefix"] } : {}),
          };
        }),
      });
    }
    const rawName = type === "activity-alias" ? (a["android:targetActivity"] ?? a["android:name"]) : a["android:name"];
    if (!rawName) continue;
    const name = rawName.startsWith(".") ? pkg + rawName : rawName.includes(".") ? rawName : `${pkg}.${rawName}`;
    // Without an explicit flag, components with intent filters are exported (pre-Android 12 rule).
    const exported = a["android:exported"] !== undefined ? a["android:exported"] === "true" : filters.length > 0;
    components.push({
      type,
      name,
      exported,
      ...(a["android:permission"] ? { permission: a["android:permission"] } : {}),
      ...(a["android:authorities"] ? { authorities: a["android:authorities"].split(";").filter(Boolean) } : {}),
      filters,
    });
  }
  return { package: pkg, components };
}

// ---- decompiled code ----------------------------------------------------------

export interface DecompiledMethod {
  class_name: string;
  method: string;
  evidence_id: string;
  text: string;
}

const EXTRA_TYPES: Record<string, AdbBinding["extras"][number]["type"]> = { String: "s", Int: "i", Long: "l", Float: "f", Boolean: "z" };

/** Intent extras a component reads: `getStringExtra("title")`, `getBooleanExtra("pinned", false)`. */
export function readExtras(code: string): { key: string; type: AdbBinding["extras"][number]["type"] }[] {
  const out: { key: string; type: AdbBinding["extras"][number]["type"] }[] = [];
  for (const m of code.matchAll(/\bget(String|Int|Long|Float|Boolean)Extra\(\s*"([^"]+)"/g)) {
    if (!out.some((e) => e.key === m[2])) out.push({ key: m[2]!, type: EXTRA_TYPES[m[1]!]! });
  }
  return out;
}

/** UriMatcher patterns: `addURI(AUTHORITY, "notes/#", 2)` → `notes/#`. */
export function readUriPatterns(code: string): string[] {
  return [...new Set([...code.matchAll(/\.addURI\(\s*[^,]+,\s*"([^"]*)"/g)].map((m) => m[1]!))];
}

export interface TableSchema {
  table: string;
  columns: { name: string; sqlType: string; notNull: boolean; primaryKey: boolean }[];
}

/** `CREATE TABLE notes (_id INTEGER PRIMARY KEY, title TEXT NOT NULL, ...)` literals. */
export function readTables(code: string): TableSchema[] {
  const out: TableSchema[] = [];
  for (const m of code.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?(\w+)["`]?\s*\(([^"]*?)\)\s*"/gi)) {
    const columns = m[2]!
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(c))
      .map((c) => {
        const [name, type = "TEXT"] = c.split(/\s+/);
        return { name: name!.replace(/["`]/g, ""), sqlType: type.toUpperCase(), notNull: /NOT NULL/i.test(c), primaryKey: /PRIMARY KEY/i.test(c) };
      });
    out.push({ table: m[1]!, columns });
  }
  return out;
}

const columnType = (sql: string): "string" | "integer" | "number" => (/INT/.test(sql) ? "integer" : /REAL|FLOA|DOUB|NUM/.test(sql) ? "number" : "string");
const bindType = (sql: string): AdbBinding["binds"][number]["type"] => (/INT/.test(sql) ? "l" : /REAL|FLOA|DOUB|NUM/.test(sql) ? "d" : "s");

// ---- operations -----------------------------------------------------------------

const DESTRUCTIVE = /^(delete|remove|clear|reset|wipe|purge|erase|uninstall)$/;
const READ = /^(view|show|open|main|search|list|get|read|browse|display)$/;
const WRITE = /^(add|create|new|insert|save|edit|update|send|share|set|import|compose|record)$/;

export function classifyActivity(words: string[]): Operation["effects"] {
  if (words.some((w) => DESTRUCTIVE.test(w))) return "destructive";
  if (words.some((w) => WRITE.test(w))) return "write";
  // Opening a screen changes what the device shows, so even "view" stays unknown.
  return "unknown";
}

export interface AndroidExtractOptions {
  targetName: string;
  reaVersion: string;
  apkPath: string;
  packageEvidence: { evidence_id: string; manifest: string };
  /** Decompiled methods of exported components and SQLite helpers. */
  methods: DecompiledMethod[];
  fixtures?: Fixture[];
}

export function extractAndroid(options: AndroidExtractOptions): ForgeIR {
  const manifest = parseManifest(options.packageEvidence.manifest);
  const pkg = manifest.package;
  const prefix = snake(options.targetName);
  const notes: string[] = [];
  const operations: Operation[] = [];
  const manifestRef: EvidenceRef = { evidence_id: options.packageEvidence.evidence_id, note: "AndroidManifest.xml" };
  const tables = options.methods.flatMap((m) => readTables(m.text).map((t) => ({ ...t, evidence_id: m.evidence_id, class_name: m.class_name })));
  const push = (op: Operation) => {
    while (operations.some((o) => o.id === op.id)) op = { ...op, id: `${op.id}_2`, name: `${op.name}_2` };
    operations.push(op);
  };

  for (const c of manifest.components) {
    if (!c.exported) continue;
    const shortName = c.name.startsWith(`${pkg}.`) ? c.name.slice(pkg.length) : c.name;
    if (c.permission) notes.push(`${shortName} requires permission ${c.permission}; callers without it are refused by Android.`);

    if (c.type === "provider") {
      const authority = c.authorities?.[0];
      if (!authority) continue;
      const code = options.methods.filter((m) => m.class_name === c.name);
      const patterns = code.flatMap((m) => readUriPatterns(m.text));
      if (!patterns.length) {
        notes.push(`Provider ${authority}: no UriMatcher paths found in its code; not modeled.`);
        continue;
      }
      const codeRefs: EvidenceRef[] = code.map((m) => ({ evidence_id: m.evidence_id, note: `${shortName}.${m.method}` }));
      for (const pattern of patterns) {
        const segments = pattern.split("/").filter(Boolean);
        const isItem = segments.at(-1) === "#";
        const resource = segments.filter((s) => s !== "#" && s !== "*").at(-1) ?? "items";
        const table = tables.find((t) => t.table === resource);
        const idArg = `${singular(snake(resource))}_id`;
        const uri = `content://${authority}/${segments.map((s) => (s === "#" ? `{${idArg}}` : s === "*" ? "{key}" : s)).join("/")}`;
        const columns = (table?.columns ?? []).map((col) => ({ name: col.name, type: columnType(col.sqlType) }));
        const evidence = [manifestRef, ...codeRefs, ...(table ? [{ evidence_id: table.evidence_id, note: `CREATE TABLE ${table.table} in ${table.class_name}` }] : [])];
        const unknowns = table ? [] : [`No CREATE TABLE found for "${resource}"; row columns are unknown.`];
        const rowSchema: JsonSchema = table
          ? { type: "object", properties: Object.fromEntries(columns.map((col) => [col.name, { type: [col.type, "null"] }])) }
          : { type: "object" };
        const pathProps: Record<string, JsonSchema> = isItem ? { [idArg]: { type: "integer", minimum: 0, description: `Numeric id in ${uri}.` } } : {};
        const base = { auth: "none" as const, confidence: "inferred" as const, sample_count: 0, evidence, unknowns };
        const binding = (op: AdbBinding["op"], extra: Partial<AdbBinding> = {}): AdbBinding => ({ kind: "adb", package: pkg, op, uri_template: uri, binds: [], columns, extras: [], ...extra });
        const words = singular(snake(resource));

        // Query: the whole collection or one row.
        const queryName = isItem ? `${prefix}_get_${words}` : `${prefix}_query_${snake(resource)}`;
        push({
          ...base,
          id: queryName,
          name: queryName,
          title: humanize(queryName),
          description: isItem ? `Get one ${words.replace(/_/g, " ")} by id from the app's content provider.` : `List ${resource.replace(/_/g, " ")} from the app's content provider.`,
          binding: binding("provider-query"),
          input: {
            type: "object",
            properties: { ...pathProps, ...(columns.length ? { columns: { type: "array", items: { type: "string", enum: columns.map((c2) => c2.name) }, description: "Columns to return (default: all)." } } : {}) },
            ...(isItem ? { required: [idArg] } : {}),
            additionalProperties: false,
          },
          output: { type: "object", properties: { rows: { type: "array", items: rowSchema }, count: { type: "integer" } }, required: ["rows", "count"] },
          effects: "read",
          idempotent: true,
        });

        // Writes: insert on the collection, update/delete on one row.
        const writable = table ? table.columns.filter((col) => !col.primaryKey) : [];
        const bindProps: Record<string, JsonSchema> = Object.fromEntries(writable.map((col) => [snake(col.name), { type: columnType(col.sqlType), description: `Column ${col.name} (${col.sqlType}).` }]));
        const binds = writable.map((col) => ({ name: snake(col.name), column: col.name, type: bindType(col.sqlType) }));
        if (!isItem && writable.length) {
          const name = `${prefix}_insert_${words}`;
          const required = writable.filter((col) => col.notNull).map((col) => snake(col.name));
          push({
            ...base,
            id: name,
            name,
            title: humanize(name),
            description: `Insert a ${words.replace(/_/g, " ")} through the app's content provider.`,
            binding: binding("provider-insert", { binds }),
            input: { type: "object", properties: bindProps, ...(required.length ? { required } : {}), additionalProperties: false },
            output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            effects: "write",
            idempotent: false,
          });
        }
        if (isItem) {
          if (writable.length) {
            const name = `${prefix}_update_${words}`;
            push({
              ...base,
              id: name,
              name,
              title: humanize(name),
              description: `Update fields of one ${words.replace(/_/g, " ")} by id.`,
              binding: binding("provider-update", { binds }),
              input: { type: "object", properties: { ...pathProps, ...bindProps }, required: [idArg], additionalProperties: false },
              output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
              effects: "write",
              idempotent: true,
            });
          }
          const name = `${prefix}_delete_${words}`;
          push({
            ...base,
            id: name,
            name,
            title: humanize(name),
            description: `Delete one ${words.replace(/_/g, " ")} by id. This permanently removes it from the app.`,
            binding: binding("provider-delete"),
            input: { type: "object", properties: pathProps, required: [idArg], additionalProperties: false },
            output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            effects: "destructive",
            idempotent: true,
          });
        }
      }
      continue;
    }

    if (c.type !== "activity" && c.type !== "activity-alias") {
      notes.push(`Exported ${c.type} ${shortName} is not modeled (services and receivers have no reply channel over adb).`);
      continue;
    }
    const code = options.methods.filter((m) => m.class_name === c.name);
    const extras = code.flatMap((m) => readExtras(m.text)).filter((e, i, all) => all.findIndex((x) => x.key === e.key) === i);
    const codeRefs: EvidenceRef[] = code.map((m) => ({ evidence_id: m.evidence_id, note: `${shortName}.${m.method}` }));
    const extraProps: Record<string, JsonSchema> = Object.fromEntries(
      extras.map((e) => [snake(e.key), { type: { s: "string", i: "integer", l: "integer", f: "number", z: "boolean" }[e.type], description: `Intent extra "${e.key}".` }]),
    );
    const extraBinds = extras.map((e) => ({ name: snake(e.key), key: e.key, type: e.type }));
    const component = `${pkg}/${shortName}`;
    const filters = c.filters.length ? c.filters : [{ actions: [], categories: [], data: [] }];
    for (const f of filters) {
      const launcher = f.actions.includes("android.intent.action.MAIN") && f.categories.includes("android.intent.category.LAUNCHER");
      const action = f.actions.find((x) => x !== "android.intent.action.MAIN");
      const data = f.data.find((d) => d.scheme);
      const dataTemplate = data ? `${data.scheme}://${data.host ?? ""}${data.path ?? data.pathPrefix ?? ""}${data.path ? "" : "/{path}"}` : undefined;
      const label = launcher ? "open_app" : data ? `open_${snake(data.host ?? data.scheme!)}_link` : action ? snake(action.split(".").at(-1)!) : `open_${snake(shortName.replace(/^\./, "").replace(/Activity$/, ""))}`;
      const name = `${prefix}_${label}`;
      const props: Record<string, JsonSchema> = { ...(dataTemplate?.includes("{path}") ? { path: { type: "string", description: `Path appended to ${dataTemplate.replace("/{path}", "/")}.` } } : {}), ...extraProps };
      const words = [...snake(label).split("_"), ...snake(shortName).split("_")];
      push({
        id: name,
        name,
        title: humanize(name),
        description: `${launcher ? "Open the app" : data ? `Open a ${data.scheme}:// link in the app` : `Send the ${action ?? "explicit"} intent to ${shortName}`}.${extras.length ? ` Extras: ${extras.map((e) => e.key).join(", ")}.` : ""}`,
        binding: {
          kind: "adb",
          package: pkg,
          op: "activity",
          component,
          ...(action && !launcher ? { intent_action: action } : {}),
          ...(dataTemplate ? { data_uri_template: dataTemplate } : {}),
          binds: [],
          columns: [],
          extras: extraBinds,
        },
        input: { type: "object", properties: props, ...(dataTemplate?.includes("{path}") ? { required: ["path"] } : {}), additionalProperties: false },
        output: { type: "object", properties: { started: { type: "boolean" }, component: { type: "string" } }, required: ["started"] },
        auth: "none",
        effects: classifyActivity(words),
        idempotent: false,
        confidence: "inferred",
        sample_count: 0,
        evidence: [manifestRef, ...codeRefs],
        unknowns: ["What this screen does with its intent is not observed; effects are inferred from names only."],
      });
    }
  }

  operations.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ir_version: 1,
    target: { kind: "android", name: options.targetName, apk_path: options.apkPath, package: pkg },
    rea_version: options.reaVersion,
    operations,
    auth: { kind: "none", credential_fields: [], evidence: [] },
    fixtures: options.fixtures ?? [],
    sources: [],
    cli_help: [],
    notes,
  };
}
