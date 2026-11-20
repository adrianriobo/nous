## Communication Standard

All communication follows **ASD-STE100** (Standard for the Use of Simplified Technical English).

### ASD-STE100 Rules

Apply these rules to **all** agent output: conversational replies, commit messages, MR descriptions, code comments, and documentation.

- Use **approved words** from the STE dictionary. Do not use synonyms or informal alternatives.
- Keep sentences **short** (max 20 words for procedural text, max 25 words for descriptive text).
- Use the **active voice**. Write "The task updates the file", not "The file is updated by the task".
- Use the **imperative mood** for instructions. Write "Set the variable", not "You should set the variable".
- One instruction per sentence. Do not combine two actions with "and".
- Use **specific terms consistently**. Do not use different words for the same thing.
- Do not use **slang, jargon, or colloquial expressions** unless they are standard technical terms.
- Use articles (a, an, the) correctly. Do not omit them.
- Write **positive instructions**. Write "Keep the file", not "Do not delete the file" (when possible).

## Tool Discovery

Use `command -v <tool>` to check a tool. `command -v` is a shell builtin, so it is always available. The image also provides `which`, `curl`, `ps`, `openssl`, `dig`, `host`, and `nslookup`. Use `command -v` before `which`.

## Work Locations

All repository cloning and work operations must use `/workspace` folder. This ensures content persists across sessions.

### Persistent Locations

- `/workspace` — Primary folder for cloning repositories, building, and all work
- `/sandbox/AGENTS.md` — Task-specific instructions (persists across sessions)
- `/sandbox/wiki/` — Personal knowledge base (search before starting any task)

All changes in these mounted locations persist on the host filesystem across container restarts.

## Git Configuration

Before committing, set your git identity:

```bash
git config user.name "Adrian Riobo"
git config user.email "ariobolo@redhat.com"
```

## Code Review Procedure

When the user asks to review a PR, MR, or code changes, always run `code_review` (Alibaba open-code-review) **first**:

1. Clone the repository and fetch the PR/MR branch.
2. Call `code_review(mode: "preview")` to see which files OCR selects.
3. Call `code_review(files: [...])` to get rule-based findings.
4. Read the flagged files and apply your own analysis on top of the OCR results.
5. Present the combined findings.

`code_review` runs a deterministic rule engine. It catches issues that LLM analysis can miss (style violations, anti-patterns, security rules). Always run it before your own review.

## Self Review

Run a self review after you change a file. Run it before the final answer. Do not review a read-only run: an analysis, a wiki page, a Jira or Slack query, or a plain answer.

1. List the changed files with `git status --porcelain` and the diff.
2. Call `code_review(mode: "preview")` from the repository root. Use repository-relative paths. An absolute path gives an `ocr` error.
3. Call `code_review(files: [...])` for the selected files.
4. Read each flagged file. Add your own analysis. Check these items:
   - A renamed or removed symbol: search the old name in the code and the documents.
   - A new option or flag: search the documents and the tables.
   - A pull request or merge request body: compare it with the final diff.
5. Fix the blocking findings in the same run.
6. Run the tests for the change again.
7. Report one short table: finding, action, result.

The `self-review` extension adds one reminder when a run changes a file and no `code_review` call ran. The reminder is not a hard block. Pi cannot stop the answer. The review is one check. It does not guarantee correct code.

Set `NOUS_SELF_REVIEW=off` to disable the reminder. The default value is `auto`.

## Startup Procedure

Before starting any task, follow these steps in order:

1. **Search the wiki** for context related to the task. Use `wiki_search` with keywords from the user request (project names, technologies, components, error messages).
2. **Read matching wiki pages** with `wiki_read` to get the full context.
3. **Read the session journal.** Read `/workspace/journal.md` when the file exists. Use the open record to get the current state of the work. See [Session Journal](#session-journal).
4. **Check /workspace** for existing work artifacts from prior sessions.
5. **Then proceed** with the task using the gathered context.

Do not skip step 1. The wiki at `/sandbox/wiki` contains domain knowledge, prior analysis, infrastructure inventory, cost data, and reusable patterns. Always search before starting work.

### Wiki Search Examples

- User asks about GitLab runners → search "GitLab runner", "runner queue", "runner sizing"
- User asks about a Jira ticket → search the project key, component name
- User asks about Terraform → search "Terraform", "state drift", "infrastructure"
- User asks about costs → search "cost", "pricing", "capacity"
- User asks about a specific project → search the project name

### What This Achieves

- Avoids duplicating analysis that was already done
- Provides historical context from prior sessions
- Surfaces reusable patterns and procedures
- Ensures continuity across sessions

## Session Journal

Every request must leave a record in the session journal. The journal holds the state of the work. A new session can continue the work after a container restart or a broken session.

The journal extension writes the file. It uses `/workspace/journal.md`. When `/workspace` does not exist or is not writable, the extension uses `/sandbox/journal.md`. The extension opens a record for each request. It adds an entry for each tool call and for each final answer. The extension adds the newest open record to the system prompt at the start of each run.

Use the `journal` tool for the parts that need a decision: add a note, close the record, list the records, or resume the open record.

### Journal Rules

1. **Read the state.** Use the record in the system prompt. Call the `journal` tool with `action: "resume"` when you need the last entries.
2. **Add notes.** Call the `journal` tool with `action: "note"` for each decision, blocker, or key file path. The extension records the tool calls.
3. **Close the record.** Call the `journal` tool with `action: "close"` before the final answer. Set the status to `done` when the work is complete. Set the status to `blocked` when the task needs input from the user. Set the status to `handed-over` when another person or agent continues the work.
4. **Keep it short.** Use short notes. Do not copy long command output into the journal.
5. **Record new work.** The extension opens a new record for each new request. Continue the earlier record when the user adds work to it.

### Resume Procedure

When the user asks to continue the work, follow these steps in order:

1. Read the newest record with the status `open` or `blocked` from the system prompt.
2. Read the last entry of that record.
3. Continue the work from that point.
4. Skip the steps that the record shows as complete.
5. Call the `journal` tool with `action: "resume"` when the system prompt has no open record.

### Record Format

The extension writes this format. A person can read it. Do not edit the file by hand.

````markdown
## J-20260210-01 — Migrate the unit-test job to Konflux

- status: open
- started: 2026-02-10T09:12:00Z
- request: Evaluate the migration path for the unit-test job.

### 09:12 — plan
Read `.gitlab-ci.yml`. List the job commands.

### 09:30 — result
The job runs `pytest`. Konflux can run `pytest` in a Tekton task.

### 10:40 — close (done)
The PipelineRun passed.
````
