// Drives a scripted user session against the demo app and writes a HAR 1.2 file,
// standing in for "export HAR from DevTools" so tests are reproducible.
import { writeFile } from "node:fs/promises";
import { createApp } from "./server.mjs";

export async function recordHar(outPath) {
  const server = createApp();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const entries = [];
  let cookie = "";
  let csrf = "";

  async function call(method, path, body) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;
    const started = new Date();
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const url = new URL(base + path);
    entries.push({
      startedDateTime: started.toISOString(),
      time: Date.now() - started.getTime(),
      request: {
        method,
        url: url.href,
        httpVersion: "HTTP/1.1",
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: body === undefined ? 0 : JSON.stringify(body).length,
        ...(body === undefined ? {} : { postData: { mimeType: "application/json", text: JSON.stringify(body) } }),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        httpVersion: "HTTP/1.1",
        headers: [...res.headers].map(([name, value]) => ({ name, value })),
        cookies: [],
        content: { size: text.length, mimeType: res.headers.get("content-type") ?? "", text },
        redirectURL: "",
        headersSize: -1,
        bodySize: text.length,
      },
      cache: {},
      timings: { send: 0, wait: Date.now() - started.getTime(), receive: 0 },
    });
    return text ? JSON.parse(text) : undefined;
  }

  const login = await call("POST", "/api/login", { username: "demo", password: "demo-password" });
  csrf = login.csrf_token;
  await call("GET", "/api/me");
  const page1 = await call("GET", "/api/notes?limit=3");
  const page2 = await call("GET", `/api/notes?limit=3&cursor=${page1.next_cursor}`);
  await call("GET", `/api/notes?limit=3&cursor=${page2.next_cursor}`);
  await call("GET", "/api/notes?limit=5&tag=work");
  await call("GET", `/api/notes/${page1.items[0].id}`);
  await call("GET", `/api/notes/${page1.items[1].id}`);
  await call("GET", "/api/search?q=trip");
  await call("GET", "/api/search?q=notes");
  await call("GET", "/api/tags");
  const created = await call("POST", "/api/notes", { title: "Call plumber", body: "Kitchen sink", tags: ["home"] });
  await call("POST", "/api/notes", { title: "Pick up keys", tags: ["errands"], pinned: true, color: "blue" });
  await call("PATCH", `/api/notes/${created.id}`, { pinned: true });
  await call("PATCH", `/api/notes/${created.id}`, { title: "Call plumber today", color: "green" });
  await call("DELETE", `/api/notes/${created.id}`);

  const har = { log: { version: "1.2", creator: { name: "mcp-forge web-demo recorder", version: "0.1.0" }, pages: [], entries } };
  await writeFile(outPath, JSON.stringify(har, null, 2));
  server.close();
  return outPath;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const out = process.argv[2] ?? new URL("./demo.har", import.meta.url).pathname;
  await recordHar(out);
  console.log(`wrote ${out}`);
}
