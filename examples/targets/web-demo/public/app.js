// Front-end bundle for the demo app. Some endpoints here (archive, export) are
// referenced in code but never exercised in the recorded session, so static
// analysis has something to find that traffic alone would miss.
let csrf = null;
export const NOTE_COLORS = ["yellow", "blue", "green"];
export const EXPORT_FORMATS = ["json", "markdown"];
const api = (path, init = {}) =>
  fetch(path, { ...init, headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...init.headers } }).then((r) => r.json());

export const login = async (username, password) => {
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
  csrf = r.csrf_token;
  return r;
};
export const listNotes = (cursor, limit = 3, tag) => api(`/api/notes?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}${tag ? `&tag=${tag}` : ""}`);
export const getNote = (id) => api(`/api/notes/${id}`);
// `color` must be one of NOTE_COLORS; the server defaults to "yellow".
export const createNote = (note) => api("/api/notes", { method: "POST", body: JSON.stringify(note) });
export const updateNote = (id, patch) => api(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteNote = (id) => fetch(`/api/notes/${id}`, { method: "DELETE", headers: { "x-csrf-token": csrf } });
export const search = (q) => api(`/api/search?q=${encodeURIComponent(q)}`);
export const listTags = () => api("/api/tags");
export const archiveNote = (id) => api(`/api/notes/${id}/archive`, { method: "POST" });
// format: one of EXPORT_FORMATS.
export const exportNotes = (format) => api(`/api/export?format=${format}`);
