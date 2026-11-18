# role-agent extension

Declarative role switching for Pi: `handoff` (transfer control to another role),
`delegate` (run a bounded child session and continue), oversized tool-output
archiving, and read-only roles. It ships with this package and is loaded with an
explicit `-e`, so it keeps working under `--no-extensions`:

```bash
ROLE_RUN=/path/to/run-dir pi --no-extensions --no-skills \
  -e node_modules/@earendil-works/pi-coding-agent/role-agent/pi_extension.ts ...
```

`ROLE_RUN` must contain the `spec.json` written by the experiment harness (strategy
graph, current role, workspace, limits, archive directory). Strategy directories
live with the experiment, not here.

## Files

| File | Purpose |
| --- | --- |
| `pi_extension.ts` | Hooks: model/effort selection per role, request projection, control tools, read-only enforcement, output archiving. |
| `protocol.mjs` | Tool schemas, argument validation, interaction projection, observation compaction. |
| `child_runner.mjs` | Starts the child Pi session for `delegate` (resolves this package's own `dist/bundle/cli.js` when `/usr/local/bin/pi` is absent). |
| `delegate-scope.ts` | Hard gate that keeps `delegate` an evidence reader. |

## Delegate scope

A role enables the gate with a `scope` block in its delegate config:

```json
"delegate": { "enable": true, "valid_roles": ["reader"], "scope": { "min_bytes": 65536, "min_lines": 2000 } }
```

A delegate call is then accepted only if its `context` or `prompt` names at least
one archived tool output (`<obs_archive_dir>/obs_*.log`) or an existing file of at
least `min_bytes` bytes or `min_lines` lines. Other calls are blocked before they
start (they do not count against `max_delegates`), and the model is told to read
the file itself. Accepted and rejected calls are logged to `events.jsonl` as
`delegate_scope_ok` / `delegate_scope_rejected`.

## Fail-closed requests

This fork also changes Pi core: when any `before_provider_request` handler throws,
the request is aborted instead of being sent with the untransformed payload. The
extension relies on that and rethrows projection errors (it used to call
`process.exit(70)` for the same purpose); it still writes `fatal.json` first.
