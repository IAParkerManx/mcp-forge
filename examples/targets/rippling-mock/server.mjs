// A local stand-in for the parts of Rippling's REST API a timesheet tool needs.
//
// Shapes and rules follow Rippling's public guides:
//   https://developer.rippling.com/documentation/rest-api/guides/create-time-entry
//   https://developer.rippling.com/documentation/rest-api/guides/time-getting-started
// - TimeEntry fields, list envelopes ({ results, next_link }), Bearer tokens
// - worker_id required; duration XOR job_shifts; one entry per day per worker
// - unique idempotency_key; statuses DRAFT / APPROVED / FINALIZED / PAID
// - tokens act as their owner: employees see and change only their own entries
// Stand-ins (the real API reference needs a Rippling sign-in, not yet read):
// - GET /me (who the token belongs to) and the time card shape.
// Nothing here talks to Rippling.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const USERS = {
  "mock-token-ada": { user_id: "u_ada", worker_id: "6569930dfb7bc7c3510f5bac", name: "Ada Lovelace", scope: "self" },
  "mock-token-grace": { user_id: "u_grace", worker_id: "66a42da5d80b34a7fc92a3df", name: "Grace Hopper", scope: "self" },
  "mock-token-admin": { user_id: "u_admin", worker_id: "65699281fb7bc7c3510f44a6", name: "Payroll Admin", scope: "company" },
};
const PAY_ANCHOR = Date.UTC(2026, 0, 5); // pay periods are two weeks from this Monday
const DAY = 86_400_000;

export const entryId = (workerId, date) => createHash("sha256").update(`${workerId}:${date}`).digest("hex").slice(0, 24);
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");

function payPeriod(date) {
  const day = Date.parse(`${date}T00:00:00Z`);
  const start = PAY_ANCHOR + Math.floor((day - PAY_ANCHOR) / (14 * DAY)) * 14 * DAY;
  return { start_date: new Date(start).toISOString().slice(0, 10), end_date: new Date(start + 13 * DAY).toISOString().slice(0, 10), pay_schedule_id: "65699295fb7bc7c3510f4075" };
}

function makeEntry({ worker_id, date, duration, comments = [], tags = [], status = "DRAFT", idempotency_key = null }) {
  const start = Date.parse(`${date}T09:00:00Z`);
  const period = payPeriod(date);
  const regular = Math.min(duration, 8);
  return {
    id: entryId(worker_id, date),
    created_at: iso(start),
    updated_at: iso(start),
    worker_id,
    worker: null,
    start_time: iso(start),
    end_time: iso(start + duration * 3_600_000),
    comments: comments.map((c) => ({ text: c.text, author_id: worker_id, created_at: iso(start) })),
    job_shifts: [],
    breaks: [],
    tags,
    idempotency_key,
    create_extra_hours_run: false,
    status,
    pay_period: period,
    time_entry_summary: { regular_hours: regular, over_time_hours: Math.max(0, duration - 8), double_over_time_hours: 0, duration },
    time_card_id: createHash("sha256").update(`card:${worker_id}:${period.start_date}`).digest("hex").slice(0, 24),
    time_card: null,
    shift_input_values: [],
  };
}

export function createApp({ today = "2026-01-14" } = {}) {
  const entries = new Map();
  const seed = (e) => entries.set(e.id, e);
  // An entry the admin already approved for Ada, and one of Grace's drafts.
  seed(makeEntry({ worker_id: USERS["mock-token-ada"].worker_id, date: "2026-01-12", duration: 8, status: "APPROVED" }));
  seed(makeEntry({ worker_id: USERS["mock-token-grace"].worker_id, date: "2026-01-12", duration: 6, comments: [{ text: "Field day" }] }));

  const visible = (user, e) => user.scope === "company" || e.worker_id === user.worker_id;
  const error = (res, status, code, message) => send(res, status, { code, message });
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const user = USERS[/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? ""];
    if (!user) return error(res, 401, "unauthorized", "Missing or invalid API token.");

    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return error(res, 400, "invalidJson", "Request body is not valid JSON.");
      }
    }

    if (req.method === "GET" && path === "/me") return send(res, 200, { user_id: user.user_id, worker_id: user.worker_id, name: user.name });

    if (req.method === "GET" && path === "/time-entries") {
      const results = [...entries.values()].filter((e) => visible(user, e)).sort((a, b) => b.start_time.localeCompare(a.start_time));
      return send(res, 200, { results, next_link: null });
    }

    if (req.method === "GET" && path === "/time-cards") {
      const cards = new Map();
      for (const e of [...entries.values()].filter((x) => visible(user, x))) {
        const card = cards.get(e.time_card_id) ?? { id: e.time_card_id, worker_id: e.worker_id, pay_period: e.pay_period, summary: { total_hours: 0, approved_hours: 0, draft_hours: 0, paid_hours: 0 } };
        const h = e.time_entry_summary.duration;
        card.summary.total_hours += h;
        if (e.status === "DRAFT") card.summary.draft_hours += h;
        else if (e.status === "PAID") card.summary.paid_hours += h;
        else card.summary.approved_hours += h;
        cards.set(card.id, card);
      }
      return send(res, 200, { results: [...cards.values()], next_link: null });
    }

    if (req.method === "POST" && path === "/time-entries") {
      if (!body.worker_id) return error(res, 400, "workerIdRequired", "worker_id is required.");
      if (!visible(user, { worker_id: body.worker_id })) return error(res, 403, "permissionDenied.authorDoesNotHavePermission", "You cannot create time entries for this worker.");
      if (body.duration !== undefined && body.job_shifts !== undefined) return error(res, 400, "durationAndJobShifts", "Send duration or job_shifts, not both.");
      if (body.job_shifts !== undefined) return error(res, 400, "notSupportedByMock", "This mock only supports hours-only (duration) entries.");
      if (typeof body.duration !== "number" || body.duration <= 0) return error(res, 400, "entryMustHaveJobShifts", "Send duration (hours) or job_shifts.");
      if (body.duration > 48) return error(res, 400, "entryLongerThanFortyEightHours", "The entry cannot exceed 48 hours.");
      const status = body.status ?? "DRAFT";
      if (!["DRAFT", "APPROVED", "FINALIZED", "PAID"].includes(status)) return error(res, 400, "invalidStatus", `Unknown status ${status}.`);
      if (status !== "DRAFT" && user.scope !== "company") return error(res, 403, "cannotApproveEntry", "Only approvers can create non-draft entries.");
      const date = body.start_date ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(res, 400, "invalidStartDate", "start_date must be YYYY-MM-DD.");
      if (body.idempotency_key && [...entries.values()].some((e) => e.idempotency_key === body.idempotency_key)) {
        return error(res, 400, "duplicateIdempotencyKey", "A time entry with this idempotency_key already exists.");
      }
      const id = entryId(body.worker_id, date);
      const existing = entries.get(id);
      if (existing) return error(res, 400, existing.status === "DRAFT" ? "existingEntryOverlapsWithOpenEntry" : "existingEntryOverlapsWithClosedEntry", "The worker already has an entry on this day.");
      const entry = makeEntry({ worker_id: body.worker_id, date, duration: body.duration, comments: body.comments ?? [], tags: body.tags ?? [], status, idempotency_key: body.idempotency_key ?? null });
      entries.set(entry.id, entry);
      return send(res, 201, entry);
    }

    const m = /^\/time-entries\/([0-9a-f]{24})$/.exec(path);
    if (m) {
      const entry = entries.get(m[1]);
      if (!entry || !visible(user, entry)) return error(res, 404, "resourceNotFound", "No time entry exists for the provided id.");
      if (req.method === "GET") return send(res, 200, entry);
      const locked = entry.status !== "DRAFT" && user.scope !== "company";
      if (req.method === "PATCH") {
        if (!body.worker_id) return error(res, 400, "workerIdRequired", "worker_id is required.");
        if (locked) return error(res, 403, "cannotModifyApprovedEntry", "This entry is no longer a draft.");
        if (body.status && body.status !== entry.status && user.scope !== "company") return error(res, 403, "cannotApproveEntry", "Only approvers can change status.");
        if (body.duration !== undefined) {
          entry.time_entry_summary = { ...entry.time_entry_summary, duration: body.duration, regular_hours: Math.min(body.duration, 8), over_time_hours: Math.max(0, body.duration - 8) };
          entry.end_time = iso(Date.parse(entry.start_time) + body.duration * 3_600_000);
        }
        if (body.comments) entry.comments = body.comments.map((c) => ({ text: c.text, author_id: user.worker_id, created_at: entry.created_at }));
        if (body.tags) entry.tags = body.tags;
        if (body.status && user.scope === "company") entry.status = body.status;
        return send(res, 200, entry);
      }
      if (req.method === "DELETE") {
        if (locked) return error(res, 403, "cannotModifyApprovedEntry", "This entry is no longer a draft.");
        entries.delete(entry.id);
        res.writeHead(204).end();
        return;
      }
    }
    return error(res, 404, "notFound", `No route for ${req.method} ${url.pathname}.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4401);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Rippling mock on http://127.0.0.1:${port}`);
    console.log("Tokens: mock-token-ada, mock-token-grace (employees, own time only), mock-token-admin (company-wide)");
  });
}
