# Optional: Claude suggestions

`plan --enrich`, `plan --curate` and `plan --cli-help`.

Without Claude, the pipeline is fully deterministic. With access to Claude,
`mcp-forge plan` can ask Claude (`claude-opus-5-5` by default) for suggestions.
`--llm-backend` selects how it connects:

- `claude-code`: your `claude` CLI sign-in (`claude auth login` once), with no
  API key. Each request runs a locked-down headless session: no tools, no MCP
  servers, no skills, no settings, an empty working directory, and output that must
  match a JSON Schema.
- `anthropic-api`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an
  `ant auth login` profile.
- `auto` (default): `anthropic-api` when one of those credentials is set,
  otherwise `claude-code`.

```bash
# Let REA analyze the client code too, so --enrich has code to quote
mcp-forge -C /tmp/demo investigate --har /tmp/demo/web-demo.har \
  --source examples/targets/web-demo/public
mcp-forge -C /tmp/demo plan --enrich --curate          # writes forge.config.suggested.yaml + a diff
mcp-forge -C /tmp/demo plan --enrich --curate --accept # applies it (keeps forge.config.yaml.bak)
```

- **`--enrich`** reads code excerpts around the observed endpoints. It documents
  arguments and response fields (`tools.<id>.params`, `tools.<id>.outputs`), and it
  proposes endpoints that appear only in code (`inferred_operations`, always
  disabled). An enum is kept only if every value appears in a quoted excerpt. A new
  endpoint is kept only if its path segments (and non-GET method) appear there too.
  Its risk is never set below what its method implies.
- **`--curate`** proposes task-shaped names and descriptions, corrections to
  `effects`, and `groups`: several operations behind one tool with an `action`
  argument. A group starts disabled, and it never mixes read-only with write
  operations.

Guardrails:
- Every suggestion must cite REA Evidence ids (or excerpts tied to REA source
  Evidence). Uncited items are rejected and listed.
- Lowering risk needs a stated reason, and `destructive` is never lowered.
- Answers are cached in `.forge/llm-cache/` by content hash, so re-runs are free and
  reproducible.
- **Privacy:** Claude sees schemas, path templates and code excerpts with
  secret-looking literals masked. It sees no observed values unless you pass
  `--llm-send-samples`, and even then values are redacted. Check your
  organization's policy before sending captures from work systems.
- If Claude declines (`stop_reason: refusal`) or no credential is set, the stage is
  skipped and the deterministic config stays as it is.
