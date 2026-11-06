# How it works

```
investigate ──► plan ──► generate ──► verify
 REA Evidence    forge.config.yaml   standalone     replay captured calls
 → capability IR (human review)      MCP server     against the live target
```

REA observes the target. mcp-forge groups what it saw into operations, infers JSON Schemas from real samples, models sessions and tokens, writes a reviewable config, generates a server on the MCP TypeScript SDK v2, and replays the capture through that server. Every tool records the evidence it came from.

## What gets inferred

- **Operations:** method + path template (`/api/notes/{note_id}`); UUID, numeric,
  long-hex and date segments become named parameters.
- **Input schema:** path params (required), query params (typed from observed
  values; cursors stay opaque), JSON body fields (required only if present in every
  sample; PATCH bodies are all optional).
- **Output schema:** merged from every successful response, with formats
  (`uuid`, `date-time`, …) and observed string values as `examples`.
- **Effects and annotations:** GET → read-only, POST/PATCH/PUT → write,
  DELETE → destructive. Emitted as `readOnlyHint`, `destructiveHint`, `idempotentHint`.
- **Pagination:** a cursor/offset/page parameter paired with a next-cursor field.
- **Session:** cookie auth, the login request (replayed with env credentials, never
  stored), and a CSRF header traced back to the response field that supplied it.
- **Replay dependencies:** an argument whose value first appeared in an earlier
  response (a created id) is taken from the live response during `verify`.

## Layout

```
packages/forge/src/
  rea/          MCP client for `rea mcp` (pinned version)
  investigate/  per-target recipes (web, cli, electron)
  extract/      REA Evidence → capability IR (HAR, CLI help + runs, Electron bridge + IPC)
  synth/        schema inference, naming, effects, pagination, redaction
  curate/       forge.config.yaml draft/parse/apply
  codegen/      IR + config → server (templates/server)
  verify/       replay through the generated server, drift, quarantine, schema refresh
  report/       HTML evidence report
examples/targets/web-demo/  local notes app + HAR recorder (test target)
examples/targets/cli-demo/  `taskr`, a tiny task CLI with conventional --help (test target)
examples/targets/electron-demo/  DeskNotes, a small Electron app with a contextBridge API (test target)
examples/targets/android-demo/   PocketNotes, a tiny Android app built with the SDK tools (shelved M4 target)
examples/targets/rippling-mock/  local stand-in for Rippling's Time API (timesheet recipe and tests)
```
