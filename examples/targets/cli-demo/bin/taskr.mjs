#!/usr/bin/env node
// taskr: a tiny task tracker with conventional --help output. It exists only
// so mcp-forge has a CLI it is allowed to investigate. Data lives in the JSON
// file named by TASKR_DATA (default ./taskr.json).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const VERSION = "1.4.0";
const DATA = process.env.TASKR_DATA ?? "taskr.json";

const COMMANDS = {
  list: {
    summary: "List tasks",
    usage: "taskr list [options]",
    description: "List tasks, newest first.",
    options: [
      ["-s, --status <status>", "Only tasks with this status (choices: open, done)"],
      ["-t, --tag <tag>", "Only tasks with this tag"],
      ["-n, --limit <n>", "Maximum number of tasks (default: 20)"],
      ["    --json", "Print JSON"],
    ],
  },
  show: {
    summary: "Show one task",
    usage: "taskr show [options] <id>",
    description: "Show one task.",
    args: [["id", "Task id"]],
    options: [["    --json", "Print JSON"]],
  },
  add: {
    summary: "Add a task",
    usage: "taskr add [options] <title>",
    description: "Add a task.",
    args: [["title", "Task title"]],
    options: [
      ["-t, --tag <tag...>", "Tags for the task (repeatable)"],
      ["-d, --due <date>", "Due date, YYYY-MM-DD"],
      ["    --json", "Print JSON"],
    ],
  },
  done: {
    summary: "Mark a task as done",
    usage: "taskr done [options] <id>",
    description: "Mark a task as done.",
    args: [["id", "Task id"]],
    options: [["    --json", "Print JSON"]],
  },
  rm: {
    summary: "Delete a task permanently",
    usage: "taskr rm [options] <id>",
    description: "Delete a task permanently.",
    args: [["id", "Task id"]],
    options: [["-f, --force", "Do not ask for confirmation"]],
  },
  stats: {
    summary: "Show counts by status and tag",
    usage: "taskr stats [options]",
    description: "Show counts by status and tag.",
    options: [["    --json", "Print JSON"]],
  },
};

function pad(rows) {
  const width = Math.max(...rows.map(([a]) => a.length)) + 2;
  return rows.map(([a, b]) => `  ${a.padEnd(width)}${b}`).join("\n");
}

function rootHelp() {
  return `Usage: taskr [options] <command>

A tiny task tracker.

Options:
${pad([["-V, --version", "Print the version"], ["-h, --help", "Show help"]])}

Commands:
${pad(Object.entries(COMMANDS).map(([name, c]) => [name, c.summary]))}

Run "taskr <command> --help" for command options.
`;
}

function commandHelp(name) {
  const c = COMMANDS[name];
  let out = `Usage: ${c.usage}\n\n${c.description}\n`;
  if (c.args) out += `\nArguments:\n${pad(c.args)}\n`;
  out += `\nOptions:\n${pad([...c.options, ["-h, --help", "Show help"]])}\n`;
  return out;
}

const load = () => (existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : { tasks: [] });
const save = (db) => writeFileSync(DATA, JSON.stringify(db, null, 2));
const fail = (msg, code = 1) => {
  process.stderr.write(`taskr: ${msg}\n`);
  process.exit(code);
};

function parse(argv, spec) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    const match = spec.options.find(([flags]) => flags.trim().split(/[ ,]+/).includes(a));
    if (!match) fail(`unknown option ${a}`, 2);
    const long = /--([a-z-]+)/.exec(match[0])[1];
    if (/<[^>]+>/.test(match[0])) {
      const value = argv[++i];
      if (value === undefined) fail(`option ${a} needs a value`, 2);
      opts[long] = match[0].includes("...") ? [...(opts[long] ?? []), value] : value;
    } else opts[long] = true;
  }
  return { opts, positionals };
}

const idFor = (title, n) => createHash("sha256").update(`${n}:${title}`).digest("hex").slice(0, 8);

function out(value, json, text) {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + "\n" : text + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") {
  process.stdout.write(rootHelp());
  process.exit(0);
}
if (cmd === "-V" || cmd === "--version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (cmd === "help") {
  const target = rest[0];
  process.stdout.write(target && COMMANDS[target] ? commandHelp(target) : rootHelp());
  process.exit(0);
}
const spec = COMMANDS[cmd];
if (!spec) fail(`unknown command ${cmd}. See "taskr --help".`, 2);
if (rest.includes("-h") || rest.includes("--help")) {
  process.stdout.write(commandHelp(cmd));
  process.exit(0);
}
const { opts, positionals } = parse(rest, spec);
const db = load();
const find = (id) => db.tasks.find((t) => t.id === id) ?? fail(`no task ${id}`);

switch (cmd) {
  case "list": {
    let tasks = [...db.tasks].reverse();
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    if (opts.tag) tasks = tasks.filter((t) => t.tags.includes(opts.tag));
    tasks = tasks.slice(0, Number(opts.limit ?? 20));
    out({ tasks, count: tasks.length }, opts.json, tasks.map((t) => `${t.id}  [${t.status === "done" ? "x" : " "}] ${t.title}`).join("\n") || "(no tasks)");
    break;
  }
  case "show": {
    const t = find(positionals[0] ?? fail("missing <id>", 2));
    out(t, opts.json, `${t.id}  ${t.title}\nstatus: ${t.status}\ntags: ${t.tags.join(", ")}`);
    break;
  }
  case "add": {
    const title = positionals[0] ?? fail("missing <title>", 2);
    if (opts.due && !/^\d{4}-\d{2}-\d{2}$/.test(opts.due)) fail("--due must be YYYY-MM-DD", 2);
    const task = { id: idFor(title, db.tasks.length), title, status: "open", tags: opts.tag ?? [], due: opts.due ?? null, created: new Date(Date.UTC(2026, 0, db.tasks.length + 1)).toISOString() };
    db.tasks.push(task);
    save(db);
    out(task, opts.json, `added ${task.id}`);
    break;
  }
  case "done": {
    const t = find(positionals[0] ?? fail("missing <id>", 2));
    t.status = "done";
    save(db);
    out(t, opts.json, `done ${t.id}`);
    break;
  }
  case "rm": {
    const id = positionals[0] ?? fail("missing <id>", 2);
    find(id);
    if (!opts.force) fail("refusing to delete without --force", 1);
    db.tasks = db.tasks.filter((t) => t.id !== id);
    save(db);
    out({}, false, `deleted ${id}`);
    break;
  }
  case "stats": {
    const byStatus = {};
    const byTag = {};
    for (const t of db.tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      for (const tag of t.tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
    out({ total: db.tasks.length, by_status: byStatus, by_tag: byTag }, opts.json, `total ${db.tasks.length}`);
    break;
  }
}
