# Target types

Each kind of target, step by step. Run `mcp-forge doctor` first to check what your machine needs.

## Websites: step by step (demo app)

`create` is these steps run together; run them one at a time when you want to review each.

From a clone of this repository:

```bash
npm install
npm run build
npm install -g ./packages/forge   # puts `mcp-forge` on your PATH

# 1. Start the demo app (a notes API with cookie login and CSRF), and record a session
npm start -w @mcp-forge/web-demo &
node examples/targets/web-demo/record-har.mjs /tmp/demo/web-demo.har

# 2. Investigate: REA decodes the HAR; forge extracts operations into .forge/ir.json
mcp-forge -C /tmp/demo investigate --har /tmp/demo/web-demo.har

# 3. Plan: review /tmp/demo/forge.config.yaml (write/destructive tools start disabled)
mcp-forge -C /tmp/demo plan

# 4. Generate and install the server
mcp-forge -C /tmp/demo generate -o /tmp/demo/server
(cd /tmp/demo/server && npm install)

# 5. Verify: replay the capture through the generated server against the live app
WEB_DEMO_USERNAME=demo WEB_DEMO_PASSWORD=demo-password \
  mcp-forge -C /tmp/demo verify -s /tmp/demo/server \
  -e WEB_DEMO_BASE_URL=http://127.0.0.1:4317
```

Then add it to Claude Code:

```bash
claude mcp add web-demo -e WEB_DEMO_BASE_URL=http://127.0.0.1:4317 -e WEB_DEMO_USERNAME=demo -e WEB_DEMO_PASSWORD=demo-password -- node /tmp/demo/server/server.mjs
```

## Command-line tools

```bash
# Capture --help for the CLI and every subcommand (through REA's process capture).
# --run adds sample command lines; they EXECUTE, so use a scratch data dir.
mcp-forge -C /tmp/taskr investigate \
  --cli "$PWD/examples/targets/cli-demo/bin/taskr.mjs" --env TASKR_DATA=/tmp/taskr/data.json \
  --run "add 'Buy milk' --tag home --json" --run "list --json" --run "done b2c23c08 --json"
mcp-forge -C /tmp/taskr plan
mcp-forge -C /tmp/taskr generate -o /tmp/taskr/server
(cd /tmp/taskr/server && npm install)
mcp-forge -C /tmp/taskr verify -s /tmp/taskr/server -e TASKR_DATA=/tmp/taskr/verify.json
```

Each leaf subcommand becomes a tool. Positionals and options become typed arguments
(choices → `enum`, defaults, repeatable → arrays). Where the command offers
`--json` (or `--output/--format json`), it is passed automatically and the output
schema is inferred from the sample runs. Generated servers run the executable
directly, with no shell. They refuse argument values that start with `-`, so an
argument can't turn into an extra option. Commands time out after 60s and output
is capped at 10 MB. Point the server at another binary or folder with
`<NAME>_BIN` / `<NAME>_CWD`.

The parser reads commander, argparse, cobra and clap styles, headingless option
lists (curl) and two-column layouts (zip). For help it can't read (options
explained in prose), `plan --cli-help` asks Claude. A suggested flag is kept only
if it appears verbatim in that command's captured help.

## Electron apps

```bash
E=$(node -p 'require("electron")')   # or your app's own executable
mcp-forge -C /tmp/desk investigate \
  --electron-app examples/targets/electron-demo/app/main.js --electron "$E" \
  --env DESKNOTES_DATA=/tmp/desk/data.json DESKNOTES_HIDDEN=1 \
  --click "#refresh" \
  --call 'desknotes.listNotes()' 'desknotes.createNote({"title":"Buy milk","folder":"work"})'
mcp-forge -C /tmp/desk plan
mcp-forge -C /tmp/desk generate -o /tmp/desk/server
```

- **Static analysis (always).** REA finds the APIs the app exposes to its UI
  through `contextBridge` and the IPC channel and main-process handler behind
  each function. Every exposed function becomes a tool. Parameter names come from
  the preload source, and effects come from the function and channel names.
- **`--click` (optional).** REA launches the app and clicks the selectors while
  recording IPC. That evidence shows which channels are used at runtime, with
  argument and result shapes but no values.
- **`--call` (optional).** forge launches the app and makes the calls you list,
  which gives argument types, output schemas and replay fixtures. Arguments must
  be JSON values; nothing is evaluated. These calls execute for real.

Generated servers call `window.<api>.<function>(...)` in the app's renderer
through Chrome DevTools Protocol, so the app's own preload and main-process
code runs exactly as it does for its UI. Arguments travel as JSON data.
Connection options:
- **Attach** to an app you started with `--remote-debugging-port=<port>`, via
  `<NAME>_CDP_URL`. Only loopback endpoints are accepted.
- **Launch** it, via `<NAME>_ELECTRON` / `<NAME>_APP`. The app gets a private
  port and stops when the MCP client disconnects.

`plan --enrich` reads the preload and handler code too. In the demo it found the
allowed folder values from the app's `FOLDERS` constant.

## Tauri apps (read-only)

On macOS a Tauri app's WKWebView has no debugging port, and Tauri's WebDriver
support doesn't cover macOS, so nothing outside the app can call its commands.
For apps whose commands wrap the Docker CLI, forge reads the Rust source instead:

```bash
mcp-forge investigate --tauri path/to/app/src-tauri --name my-app \
  --call 'my_app_get_container_logs({"lines":20})'
```

- **What's parsed:** every `#[tauri::command]` function: its parameters (Tauri's
  injected `State`/`AppHandle`/`Window` are dropped) and its body.
- **What becomes a tool:** a command whose only effect is one read-only Docker
  call (`ps`, `logs`, `inspect`, `images`, `info`, `version`,
  `stats --no-stream`) built from literals, constants, string locals and its
  parameters. It's reproduced as that exact argv, and one level of delegation to
  a helper is followed.
- **What's skipped:** every other command is listed in the notes with the reason,
  e.g. "makes 2 Docker calls", "`docker stop …` is not a read-only Docker command",
  "body also uses std::fs::write".
- **Raw output:** tools return Docker's raw output, not the app's parsed structs.
  Evidence is the source file's hash and line (`source:sha256:…`); REA doesn't
  analyze Rust source.

## HTTP APIs without a browser UI

```bash
mcp-forge record --base http://127.0.0.1:5001 -o api.har /health /models "/status?limit=5"
mcp-forge investigate --har api.har --name my-api
```

`mcp-forge record` sends only the GET requests listed; anything else needs
`--allow-writes`.

### APIs that need a token

`create` and `record` accept a token by reference only, never as a value:

```bash
mcp-forge create https://api.example.com --token-file ~/.config/mcp-forge/example-token
mcp-forge record --base https://api.example.com -o api.har --token-env EXAMPLE_TOKEN /me
```

- `--token-env <name>` or `--token-file <path>`: where the token is read from.
  Keep token files private (`chmod 600`).
- `--token-header <name>` (default `authorization`) and `--token-scheme <scheme>`
  (default `Bearer`; `""` sends the bare token, for API-key headers).

The token is sent with each request but never printed. In the HAR it is written as
`Bearer [REDACTED]`. The generated server reads it the same way at run time, from
the variable or file named in its README.

## Your own site

For a real site, export a HAR from your own browser session (DevTools → Network →
Save all as HAR). Then sign the generated server in with either a pasted
`<NAME>_COOKIE` or `<NAME>_USERNAME`/`<NAME>_PASSWORD` for your own account.

## Android

Not supported yet. The Android target is shelved: readers for manifests and decompiled code, and an adb runtime, exist in the code, but there is no `investigate` step.
