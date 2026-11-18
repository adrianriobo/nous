# Session journal

The journal stores the state of the work in one file. A new session reads the journal and continues the work after a container restart or a broken session.

The [journal extension](../context/journal/index.ts) writes the file. The extension needs no model decision, so every interaction leaves a record. The [system instructions](../context/APPEND_SYSTEM.md#session-journal) tell the agent how to use the journal.

## File location

The extension uses the first writable directory from this list:

1. The path in `NOUS_JOURNAL`, when set.
2. `/workspace/journal.md`
3. `/sandbox/journal.md`

Mount `/workspace` to keep the journal after the container exits. Without the mount, the journal is lost with the container. See [running nous](running.md#session-journal).

## Records

The extension opens one record for each user request. A record ID has the form `J-YYYYMMDD-NN`. `NN` counts up for one UTC day.

The extension adds an entry for these events:

| Event | Entry |
|---|---|
| Session start with an open record | `session start` |
| User request | New record with the request text |
| Finished tool call | `tool <name>` with the target and the result |
| Final answer of a run | `answer` |
| Aborted run | `run stopped` |
| Session end with an open record | `session end` |

The agent adds these entries with the `journal` tool:

| Action | Result |
|---|---|
| `note` | Append a decision or a blocker. |
| `close` | Append a final entry and set the status to `done`, `blocked`, or `handed-over`. |
| `list` | Show the records and their status. |
| `resume` | Return the newest open record with the last eight entries. |

The extension never deletes a record. The file is append-only, except for the `- status:` line of a closed record.

## Resume the work

Use a new container with the same `/workspace` mount:

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  -v /path/to/workspace:/workspace:z \
  ghcr.io/adrianriobo/nous:latest \
  --print 'Continue the work from /workspace/journal.md.'
```

The extension adds the newest open record to the system prompt at the start of the run. The agent can also call `journal` with `action: "resume"`.

To find the open records without the agent:

```bash
grep -nE -- '- status: (open|blocked)' /path/to/workspace/journal.md
```

## Record format

````markdown
# Session Journal

Times are UTC. One record for each request. Append only.

## J-20260210-01 — Migrate the unit-test job to Konflux

- status: done
- started: 2026-02-10T09:12:00.000Z
- request: Evaluate the migration path for the unit-test job.

### 09:12 — tool read
- `.gitlab-ci.yml` — ok, 12ms

### 09:14 — note
The job runs `pytest`. Konflux can run `pytest` in a Tekton task.

### 10:40 — close (done)
The PipelineRun passed.
````

## Limits

- The extension stores short values. A command target is limited to 120 characters. The final answer is limited to 600 characters.
- The extension masks common credential shapes, such as GitHub tokens, API keys, and bearer headers. Review the journal before you share it.
- One journal file holds all requests. Delete or archive the file when it becomes long.
- The journal records the work of the parent session. A subagent does not open a record.

## Tests

[`tests/journal.test.mjs`](../tests/journal.test.mjs) checks the file helpers and the extension hooks. CI runs the tests in the base image. See [CI](ci.md).
