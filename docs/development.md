# Development

```bash
npm install
npm run build
npm test          # unit + offline end-to-end (no REA or network needed)
npm run typecheck
npm pack -w mcp-forge   # the publishable CLI package (mcp-forge-<version>.tgz)
```

## Continuous integration

`.github/workflows/ci.yml` runs build, typecheck and tests on Linux, macOS and Windows with Node 22 and 24. It then packs the CLI, installs the tarball into a clean prefix, and runs `mcp-forge --help` and `mcp-forge doctor`. The Electron end-to-end test skips itself when the Electron binary is absent, as it is in CI.

## Status

| Milestone | State |
|---|---|
| M0: workspace, REA client (pinned `rea-agents@6.4.0`), demo target | done |
| M1: web from a HAR capture → MCP server, replay verification | done |
| M1: JS-bundle endpoints, browser-driven capture via REA | not yet (see [Limitations](limitations.md)) |
| M2: CLI tools from `--help` (+ optional sample runs) → MCP server, replay verification | done |
| M3: Electron apps (contextBridge APIs called over a loopback debugging port) | done |
| M4: Android | **shelved, partial** — manifest/code readers and an adb runtime exist; there is no `investigate` step yet |
| M5: drift checks, quarantine, schema refresh, HTML evidence report | done |
| Tauri apps (read-only: Docker commands reproduced from Rust source) | done |
| `mcp-forge record` for HTTP APIs without a browser UI | done |
| Optional Claude stages: `plan --enrich`, `plan --curate`, `plan --cli-help` (Claude Code login or API key) | done |
| Optional Claude stages: `--flows`, `investigate --agent`, `verify --repair` | planned |
