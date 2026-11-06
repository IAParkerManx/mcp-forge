// Main process: owns the notes and answers the renderer over IPC. The data
// file is DESKNOTES_DATA (default: a temp file), so tests never touch real data.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const DATA = process.env.DESKNOTES_DATA || path.join(os.tmpdir(), "desknotes.json");
const load = () => (fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, "utf8")) : { notes: [] });
const save = (db) => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
const FOLDERS = ["inbox", "work", "personal"];

ipcMain.handle("notes:list", (_event, folder) => {
  const notes = load().notes.filter((n) => !folder || n.folder === folder);
  return { notes, count: notes.length };
});
ipcMain.handle("notes:get", (_event, id) => load().notes.find((n) => n.id === id) ?? null);
ipcMain.handle("notes:create", (_event, note) => {
  if (!note || typeof note.title !== "string") throw new Error("title is required");
  const folder = FOLDERS.includes(note.folder) ? note.folder : "inbox";
  const db = load();
  const created = { id: crypto.createHash("sha256").update(`${db.notes.length}:${note.title}`).digest("hex").slice(0, 10), title: note.title, body: note.body ?? "", folder, created: new Date(Date.UTC(2026, 0, db.notes.length + 1)).toISOString() };
  db.notes.push(created);
  save(db);
  return created;
});
ipcMain.handle("notes:delete", (_event, id) => {
  const db = load();
  const before = db.notes.length;
  db.notes = db.notes.filter((n) => n.id !== id);
  save(db);
  return { deleted: before - db.notes.length };
});
ipcMain.handle("app:info", () => ({ name: "DeskNotes", version: "0.3.0", folders: FOLDERS }));
ipcMain.on("window:set-title", (event, title) => BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title)));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: process.env.DESKNOTES_HIDDEN !== "1",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
