// Minimal notes app with a private-style JSON API. It exists only so mcp-forge
// has a target it is allowed to investigate; nothing here talks to the network.
import { createServer } from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const USERS = { demo: "demo-password" };
const sessions = new Map(); // sid -> { user, csrf }

function seedNotes() {
  const notes = new Map();
  const titles = ["Groceries", "Trip plan", "Reading list", "Ideas", "Meeting notes", "Recipes", "Workout", "Gift ideas"];
  titles.forEach((title, i) => {
    // Deterministic ids so recorded captures stay replayable across restarts.
    const h = createHash("sha256").update(`note-${i}`).digest("hex");
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    notes.set(id, {
      id,
      title,
      body: `${title} body text`,
      tags: i % 2 === 0 ? ["personal"] : ["work", "todo"],
      pinned: i === 0,
      color: ["yellow", "blue", "green"][i % 3],
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    });
  });
  return notes;
}
let notes = seedNotes();

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function session(req) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  return sid ? sessions.get(sid) : undefined;
}

// Simulated API changes for drift tests: "added" adds a field to notes,
// "breaking" renames title → name (WEB_DEMO_DRIFT or createApp({ drift })).
function shapeFor(drift) {
  if (drift === "added") return (n) => ({ ...n, archived: false });
  if (drift === "breaking") return ({ title, ...rest }) => ({ ...rest, name: title });
  return (n) => n;
}

export function createApp({ drift = process.env.WEB_DEMO_DRIFT } = {}) {
  notes = seedNotes();
  const shape = shapeFor(drift);
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/app.js")) {
      const file = path === "/" ? "index.html" : "app.js";
      const type = path === "/" ? "text/html" : "text/javascript";
      res.writeHead(200, { "content-type": type });
      res.end(await readFile(join(here, "public", file)));
      return;
    }

    if (req.method === "POST" && path === "/api/login") {
      const body = await readJson(req);
      if (!body || USERS[body.username] !== body.password) return json(res, 401, { error: "invalid_credentials" });
      const sid = randomBytes(16).toString("hex");
      const csrf = randomBytes(12).toString("hex");
      sessions.set(sid, { user: body.username, csrf });
      return json(res, 200, { user: { username: body.username }, csrf_token: csrf }, { "set-cookie": `sid=${sid}; HttpOnly; Path=/` });
    }

    if (!path.startsWith("/api/")) return json(res, 404, { error: "not_found" });
    const s = session(req);
    if (!s) return json(res, 401, { error: "unauthenticated" });
    const isWrite = req.method !== "GET" && req.method !== "HEAD";
    if (isWrite && req.headers["x-csrf-token"] !== s.csrf) return json(res, 403, { error: "csrf" });

    if (req.method === "GET" && path === "/api/me") return json(res, 200, { username: s.user, csrf_token: s.csrf });

    if (req.method === "GET" && path === "/api/notes") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 3) || 3, 50);
      const tag = url.searchParams.get("tag");
      const all = [...notes.values()].filter((n) => !tag || n.tags.includes(tag));
      const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return json(res, 200, { items: items.map(shape), next_cursor: next, total: all.length });
    }

    if (req.method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = [...notes.values()].filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
      return json(res, 200, { query: q, items: items.map(({ id, title, pinned }) => ({ id, title, pinned })) });
    }

    if (req.method === "GET" && path === "/api/tags") {
      const counts = {};
      for (const n of notes.values()) for (const t of n.tags) counts[t] = (counts[t] ?? 0) + 1;
      return json(res, 200, Object.entries(counts).map(([name, count]) => ({ name, count })));
    }

    if (req.method === "POST" && path === "/api/notes") {
      const body = await readJson(req);
      if (!body || typeof body.title !== "string") return json(res, 400, { error: "title_required" });
      const now = new Date().toISOString();
      const note = {
        id: randomUUID(),
        title: body.title,
        body: body.body ?? "",
        tags: Array.isArray(body.tags) ? body.tags : [],
        pinned: Boolean(body.pinned),
        color: body.color ?? "yellow",
        createdAt: now,
        updatedAt: now,
      };
      notes.set(note.id, note);
      return json(res, 201, shape(note));
    }

    const m = /^\/api\/notes\/([0-9a-f-]{36})$/.exec(path);
    if (m) {
      const note = notes.get(m[1]);
      if (!note) return json(res, 404, { error: "not_found" });
      if (req.method === "GET") return json(res, 200, shape(note));
      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (!body) return json(res, 400, { error: "bad_json" });
        for (const k of ["title", "body", "tags", "pinned", "color"]) if (k in body) note[k] = body[k];
        note.updatedAt = new Date().toISOString();
        return json(res, 200, shape(note));
      }
      if (req.method === "DELETE") {
        notes.delete(m[1]);
        res.writeHead(204).end();
        return;
      }
    }
    return json(res, 404, { error: "not_found" });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  createApp().listen(port, "127.0.0.1", () => console.log(`web-demo listening on http://127.0.0.1:${port}`));
}
