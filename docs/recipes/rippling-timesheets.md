# Recipe: Rippling timesheets

`examples/targets/rippling-mock` is a local stand-in for Rippling's Time API. It
follows the shapes and rules in Rippling's public guides, with
[time entries](https://developer.rippling.com/documentation/rest-api/guides/create-time-entry)
using personal Bearer tokens. Its `/me` endpoint and time card shape are stand-ins,
until they are checked against Rippling's API reference. It has three demo tokens:
- `mock-token-ada` and `mock-token-grace`: employees, own time only
- `mock-token-admin`: company-wide

```bash
npm start -w @mcp-forge/rippling-mock &                  # http://127.0.0.1:4401
export RIPPLING_TOKEN=mock-token-ada
mcp-forge record --base http://127.0.0.1:4401 -o rippling.har --token-env RIPPLING_TOKEN --allow-writes \
  /me /time-entries /time-cards \
  'POST /time-entries/ {"worker_id":"6569930dfb7bc7c3510f5bac","duration":7.5,"start_date":"2026-01-13","status":"DRAFT"}'
mcp-forge -C ./rippling investigate --har rippling.har --name rippling
mcp-forge -C ./rippling plan          # then add the pinned/guard blocks above
mcp-forge -C ./rippling generate
```

Against the real Rippling, use your own personal token. Record reads first.
Recording a write creates a real (draft) entry in Rippling, so do that once,
deliberately, and delete it afterwards.

The `pinned` and `guard` blocks to add are in [Safe write tools](../safe-write-tools.md).
