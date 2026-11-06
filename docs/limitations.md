# Limitations

- **REA 6.4.0 vs `main`:** REA's `api-surface` view exists only on its unreleased
  `main` branch, so mcp-forge groups requests itself.
- **Static JS analysis:** REA 6.4.0's `analyze_javascript_application` doesn't
  report endpoints called through a `fetch` wrapper. mcp-forge uses REA to analyze
  and identify the source, then cuts code excerpts itself. Without `--enrich`,
  code-only endpoints are not found.
- **Live Claude runs:** the `claude-code` backend has been run live on the demo app
  (Enterprise account, two calls in about 30 seconds per run). The `anthropic-api`
  backend has only been tested with recorded responses and a rejected key.
- **Claude's suggestions vary between runs.** For example, a group may be
  proposed on one run and not the next. Review the diff each time; cached answers
  make re-runs of the same input repeatable.
- **Thin samples:** schemas come from what was observed. Fields and enum values that
  never appeared are unknown, and each tool lists its unknowns.
- **Web: HTTP+JSON only.** Path segments that vary but aren't id-shaped (slugs)
  aren't templated yet.
- **Electron limits.** Only APIs exposed with a literal key in the main world are
  callable. Without `--call` samples, argument types and return shapes are unknown.
  Apps that turn off remote debugging can't be driven. Local HTTP/WebSocket servers
  inside an app go through the web path: record a HAR against them. Packaged
  `.app`/`.asar` targets are analyzed the same way but are untested here.
- **CLI: no samples, no output schema.** Commands without sample runs have no
  output schema. Interactive prompts aren't supported (stdin is closed). Nested
  subcommands are followed two levels deep (`--depth`). On macOS, REA sometimes
  can't verify process cleanup after a run (`cleanup_incomplete`). The run's output
  is then kept as a labeled partial observation instead of running the command
  again.
