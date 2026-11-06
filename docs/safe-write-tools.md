# Pinned arguments and guards (safe write tools)

Some write tools are only safe with limits. A timesheet tool, for example, should
only log your own hours, and only as drafts for approval. In `forge.config.yaml`:

```yaml
tools:
  post_time_entries:
    enabled: true
    name: log_time
    pinned:                                   # removed from the tool's inputs; the server fills them in
      worker_id: { from: get_me, pointer: /worker_id }   # from a read-only "who am I" call (cached)
      status: { value: DRAFT }                           # always this value
      idempotency_key: { template: "forge-{worker_id}-{start_date}" }   # built from other arguments
  delete_time_entries_time_entry_id:
    enabled: true
    name: delete_my_draft_entry
    pinned:
      worker_id: { from: get_me, pointer: /worker_id }   # not an argument here: available to the guard only
    guard:                                    # checked before every call, or the call is refused
      - operation: get_time_entries_time_entry_id
        args: { time_entry_id: "{time_entry_id}" }
        require: { /worker_id: "{worker_id}", /status: DRAFT }
        message: you can only change your own draft entries
```

How they behave:
- **The agent can't set pinned arguments,** because they aren't in the tool's inputs at all.
- **Pins and guards only call read-only operations.** `generate` refuses anything else.
- **Descriptions say so.** Each tool tells the agent what the server sets and which checks it makes.
- **Replay works.** `verify` drops pinned values from recorded calls and lets the server add them back.

Worked example: [Rippling timesheets](recipes/rippling-timesheets.md).
