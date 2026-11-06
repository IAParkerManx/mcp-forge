// `mcp-forge report`: one self-contained HTML page that shows, for every
// operation, where it came from (REA Evidence), how sure forge is, what is
// unknown, its schemas, its review state and the latest verify result.
import { bindingLine, type ForgeIR, type Operation } from "../ir/types.ts";
import type { ForgeConfig } from "../curate/config.ts";
import type { CheckResult } from "../verify/replay.ts";

export interface VerifyRecord {
  at: string;
  include_writes: boolean;
  results: CheckResult[];
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2de; --card:#ffffff; --code:#f3f2ee;
  --read:#1f7a4d; --write:#9a6100; --destructive:#b42318; --unknown:#5b5bd6; --pass:#1f7a4d; --fail:#b42318; --skip:#6b6b66; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161615; --fg:#ecebe7; --muted:#a3a29c; --line:#2e2d2a;
  --card:#1e1e1c; --code:#252522; --read:#5fcf95; --write:#f0b04a; --destructive:#ff7a6e; --unknown:#a5a5ff; --pass:#5fcf95; --fail:#ff7a6e; --skip:#a3a29c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 0; }
.sub { color: var(--muted); margin: 0 0 24px; }
.stats { display:flex; flex-wrap:wrap; gap:12px; margin-bottom: 24px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width: 120px; }
.stat b { display:block; font-size:20px; }
.stat span { color:var(--muted); font-size:13px; }
.op { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin: 0 0 14px; }
.op header { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; justify-content:space-between; }
.tags { display:flex; flex-wrap:wrap; gap:6px; }
.tag { font-size:12px; border:1px solid currentColor; border-radius:999px; padding:1px 8px; white-space:nowrap; }
.read{color:var(--read)} .write{color:var(--write)} .destructive{color:var(--destructive)} .unknown{color:var(--unknown)}
.pass{color:var(--pass)} .fail{color:var(--fail)} .skip,.off{color:var(--skip)}
code, pre { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background:var(--code); padding:1px 5px; border-radius:4px; overflow-wrap:anywhere; }
pre { background:var(--code); padding:10px; border-radius:6px; overflow:auto; max-height: 360px; margin: 6px 0 0; }
.desc { margin: 8px 0; }
dl { display:grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 10px 0 0; font-size: 14px; }
dt { color: var(--muted); } dd { margin: 0; min-width: 0; }
ul { margin: 0; padding-left: 18px; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--muted); font-size: 14px; }
.notes { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom: 20px; }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } }
`;

function opCard(op: Operation, config: ForgeConfig | undefined, result: CheckResult | undefined): string {
  const tool = config?.tools[op.id] ?? (config?.inferred_operations?.[op.id] ? { enabled: config.inferred_operations[op.id]!.enabled, name: op.name } : undefined);
  const name = tool?.name ?? op.name;
  const effects = ("effects" in (tool ?? {}) && (tool as { effects?: string }).effects) || op.effects;
  const state = !tool ? "not in config" : (tool as { quarantined?: unknown }).quarantined ? "quarantined" : tool.enabled ? "enabled" : "disabled";
  const q = (tool as { quarantined?: { reason: string; since: string } } | undefined)?.quarantined;
  const evidence = op.evidence
    .map((e) => `<li><code>${esc(e.evidence_id)}</code>${e.records?.length ? ` records ${esc(e.records.join(", "))}` : ""}${e.note ? ` — ${esc(e.note)}` : ""}</li>`)
    .join("");
  const drift = result?.drift;
  return `<article class="op" id="${esc(op.id)}">
  <header><h2>${esc(name)}</h2><div class="tags">
    <span class="tag ${esc(effects)}">${esc(effects)}</span>
    <span class="tag">${esc(op.confidence)}</span>
    <span class="tag ${state === "enabled" ? "pass" : state === "quarantined" ? "fail" : "off"}">${esc(state)}</span>
    ${result ? `<span class="tag ${esc(result.status)}">verify: ${esc(result.status)}</span>` : ""}
  </div></header>
  <p class="desc">${esc((tool as { description?: string } | undefined)?.description ?? op.description)}</p>
  <dl>
    <dt>Runs</dt><dd><code>${esc(bindingLine(op.binding))}</code></dd>
    <dt>Operation id</dt><dd><code>${esc(op.id)}</code></dd>
    <dt>Samples</dt><dd>${op.sample_count}</dd>
    <dt>Evidence</dt><dd><ul>${evidence}</ul></dd>
    ${op.unknowns.length ? `<dt>Unknowns</dt><dd><ul>${op.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></dd>` : ""}
    ${q ? `<dt>Quarantined</dt><dd>since ${esc(q.since)}: ${esc(q.reason)}</dd>` : ""}
    ${result ? `<dt>Last verify</dt><dd>${esc(result.detail)}</dd>` : ""}
    ${drift && (drift.added.length || drift.missing.length || drift.changed.length) ? `<dt>Drift</dt><dd>${[
      drift.missing.length ? `missing: ${drift.missing.map((m) => `<code>${esc(m)}</code>`).join(" ")}` : "",
      drift.changed.length ? `changed: ${drift.changed.map((c) => `<code>${esc(c.path)}</code> ${esc(c.expected)} → ${esc(c.actual)}`).join(", ")}` : "",
      drift.added.length ? `new: ${drift.added.map((a) => `<code>${esc(a)}</code>`).join(" ")}` : "",
    ].filter(Boolean).join("<br>")}</dd>` : ""}
  </dl>
  <details><summary>Input schema</summary><pre>${esc(JSON.stringify(op.input, null, 2))}</pre></details>
  ${op.output ? `<details><summary>Output schema</summary><pre>${esc(JSON.stringify(op.output, null, 2))}</pre></details>` : ""}
</article>`;
}

export function renderReport(ir: ForgeIR, config: ForgeConfig | undefined, verify: VerifyRecord | undefined): string {
  const resultFor = (op: Operation) => verify?.results.find((r) => r.operation_ids?.includes(op.id));
  const enabled = ir.operations.filter((o) => config?.tools[o.id]?.enabled && !config.tools[o.id]!.quarantined).length;
  const quarantined = ir.operations.filter((o) => config?.tools[o.id]?.quarantined).length;
  const observed = ir.operations.filter((o) => o.confidence === "observed").length;
  const counts = (s: string) => verify?.results.filter((r) => r.status === s).length ?? 0;
  const stat = (value: string | number, label: string) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const notes = [...ir.notes, ...Object.entries(config?.inferred_operations ?? {}).map(([id]) => `Code-only operation ${id} is listed under inferred_operations in forge.config.yaml.`)];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence report: ${esc(ir.target.name)}</title><style>${STYLE}</style></head>
<body><main>
<h1>${esc(config?.server.name ?? ir.target.name)}</h1>
<p class="sub">${esc(ir.target.kind)} target · REA ${esc(ir.rea_version)} · ${ir.operations.length} operation(s)${verify ? ` · last verify ${esc(verify.at)}${verify.include_writes ? " (writes included)" : ""}` : " · not verified yet"}</p>
<section class="stats">
  ${stat(ir.operations.length, "operations")}${stat(enabled, "enabled tools")}${stat(observed, "observed (not inferred)")}${stat(quarantined, "quarantined")}
  ${verify ? `${stat(counts("pass"), "verify passed")}${stat(counts("fail"), "verify failed")}${stat(counts("skip"), "verify skipped")}` : ""}
</section>
${notes.length ? `<section class="notes"><h2>Notes</h2><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>` : ""}
${ir.operations.map((op) => opCard(op, config, resultFor(op))).join("\n")}
</main></body></html>
`;
}
