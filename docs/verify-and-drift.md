# Keeping servers honest: drift, quarantine, report

Private APIs and tools change without notice. `mcp-forge verify` compares each live
response, field by field, with the schema inferred at investigation time:

- **Additive drift** (new fields) passes and is reported.
  `--update-schemas` folds the new fields into the output schemas; run
  `mcp-forge generate` to publish them.
- **Breaking drift** fails: required fields missing, or types changed. A rename
  shows up as "missing `title`; new field `name`".
- **`--quarantine`** marks failing tools in `forge.config.yaml`. The next
  `generate` leaves them out, and the server README lists them with the reason.
  Re-investigate, or clear `quarantined` once the target is fixed.
- **Dependents:** a replay that depends on a value from a failed call (e.g. deleting
  the note a failed create should have made) is skipped with the reason, not
  blamed.
- **Raw responses:** verify starts the server with `FORGE_VERIFY_RAW=1` so it
  sees drifted responses whole. Normal runs keep the MCP SDK's output validation.
- **`verify.json`:** every run writes `.forge/verify.json`.

```bash
mcp-forge verify -s ./server --include-writes --update-schemas   # accept new fields
mcp-forge verify -s ./server --quarantine                         # pull broken tools
mcp-forge report                                                   # .forge/report.html
```

`mcp-forge report` writes one self-contained HTML page. For every operation it shows
the REA Evidence it came from, its confidence, unknowns, review state, schemas,
and the latest verify and drift result.
