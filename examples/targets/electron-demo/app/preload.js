// The renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desknotes", {
  // folder: one of "inbox", "work", "personal"; omit for all folders.
  listNotes: (folder) => ipcRenderer.invoke("notes:list", folder),
  getNote: (id) => ipcRenderer.invoke("notes:get", id),
  createNote: (note) => ipcRenderer.invoke("notes:create", note),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),
  appInfo: () => ipcRenderer.invoke("app:info"),
  setTitle: (title) => ipcRenderer.send("window:set-title", title),
});
