# mcp-forge

Turn an HTTP API, a command-line tool, a website, or an Electron/Tauri app into a
tested [MCP](https://modelcontextprotocol.io) server, so AI agents (Claude Code,
Claude Desktop, Cursor and others) can use it as tools.

mcp-forge works from evidence: [REA](https://github.com/morluto/rea) (Reverse
Engineer Anything) observes the target, and mcp-forge turns what it saw into tools:
- input and output JSON Schemas inferred from real responses
- read-only tools enabled and anything that writes left disabled
- each generated server tested against the live target before you use it

Every tool says which evidence it came from.

> Use mcp-forge only on apps, sites and accounts you are authorized to analyze, and
> within their terms. See [DISCLAIMER.md](DISCLAIMER.md).

## Quick start

Needs Node.js 22.19+ (24 recommended). REA is fetched automatically on first use.

**1. Install**

```bash
npm install -g mcp-forge
```

Until it is published on npm, install it from this repository:
`npm install && npm run build && npm install -g ./packages/forge`.

**2. Create a server.** Point `mcp-forge create` at the thing you want to use:

```bash
mcp-forge create http://127.0.0.1:8000          # an HTTP API (reads its OpenAPI spec if it has one)
mcp-forge create jq --enable jq                 # a command-line tool on your PATH (see below)
mcp-forge create ./my-session.har               # a website: a HAR exported from your browser
mcp-forge create ./my-electron-app/main.js      # an Electron app
mcp-forge create ./my-tauri-app                 # a Tauri app (read-only Docker commands)
mcp-forge create                                # not sure? it asks
```

`create` runs every step for you:
1. investigate the target
2. draft `forge.config.yaml` with read-only tools enabled
3. generate the server into `./<name>-mcp/server`
4. install it
5. test it against the target

Useful options:
- `--get /path`: APIs without an OpenAPI document; lists the GET paths to record.
- `--run "list --json"`: sample command lines for a CLI. They are run.
- `--call 'api.fn(...)'`: sample calls for an app. They are made.
- `-e KEY=VALUE`: environment the target needs.

**3. Add it to your MCP client.** `create` ends by printing the exact command, e.g.:

```bash
claude mcp add my-api-mcp -- node /path/to/my-api-mcp/server/server.mjs
```

It also prints the same server as a JSON block for any other MCP client's config.

Only tools that are clearly read-only start enabled. A tool that may change data,
or whose effects can't be told from the evidence, starts disabled. A single-command
CLI like `jq` is in that second group. Enable the ones you trust with
`--enable <tool>`, or edit `forge.config.yaml` and run `mcp-forge -C ./my-api-mcp generate`.

## What it works with

| Target | Example | Needs |
|---|---|---|
| HTTP API | `mcp-forge create http://127.0.0.1:8000` | nothing extra (reads the OpenAPI spec if there is one; `--token-env` for APIs that need a token) |
| Website | `mcp-forge create ./session.har` | a HAR exported from your browser's DevTools |
| Command-line tool | `mcp-forge create jq --enable jq` | macOS: Xcode Command Line Tools; Linux: procps; Windows: use WSL |
| Electron app | `mcp-forge create ./app/main.js` | the app's own Electron (found automatically) |
| Tauri app | `mcp-forge create ./my-tauri-app` | Docker (read-only Docker commands only) |
| Android app | — | not supported yet |

`mcp-forge doctor` checks your machine and says how to fix anything missing.
Details for each type are in [docs/targets.md](docs/targets.md).

## Safety defaults

- Runs locally. There is no shared registry of captured APIs.
- Secrets are redacted before anything is written to `.forge/`. That covers
  password/token/CSRF-keyed values and any literal echoed elsewhere, on top of REA
  nulling Cookie/Authorization headers.
- Generated tools are read-only unless you enable others in `forge.config.yaml`.
  `verify` replays write tools only with `--include-writes`.
- No bot-protection or access-control bypass.
- CLI sample runs (`--run`) execute for real, and only the command lines you list
  are run. Help capture runs only `--help` / `help <cmd>` / `-h`.
- Electron sample calls (`--call`) execute for real. Generated servers only call
  functions the app itself exposes to its UI, with JSON arguments, over loopback.
- Saved REA Evidence has captured secret values replaced wherever they appear.
  REA's own field names are left intact.

## Documentation

- [Target types](docs/targets.md): websites, HTTP APIs, CLIs, Electron, Tauri, step by step
- [Safe write tools](docs/safe-write-tools.md): pinned arguments and guards
- [Verify, drift and the evidence report](docs/verify-and-drift.md)
- [Optional Claude suggestions](docs/ai-suggestions.md): `--enrich`, `--curate`, `--cli-help`
- [Recipe: Rippling timesheets](docs/recipes/rippling-timesheets.md)
- [How it works](docs/how-it-works.md): pipeline, what gets inferred, code layout
- [Limitations](docs/limitations.md)
- [Development](docs/development.md): building, testing, CI, status

## License

MIT. See [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).
