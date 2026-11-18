import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import registerJournal from "../context/journal/index.ts";
import {
  appendEntry,
  dayKey,
  ensureJournal,
  latestActive,
  nextRecordId,
  openRecord,
  parseRecords,
  readJournal,
  recordIndex,
  redact,
  resolveJournalFile,
  resumeText,
  sanitize,
  setStatus,
} from "../context/journal/journal.ts";

const AT_0912 = new Date("2026-02-10T09:12:00Z");
const AT_1130 = new Date("2026-02-10T11:30:00Z");
const AT_1500 = new Date("2026-02-10T15:00:00Z");
const NEXT_DAY = new Date("2026-02-11T08:00:00Z");

async function tempJournal() {
  const dir = await mkdtemp(join(tmpdir(), "nous-journal-"));
  return { dir, file: join(dir, "workspace", "journal.md") };
}

function harness() {
  const handlers = {};
  let tool;
  registerJournal({
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerTool: (definition) => {
      tool = definition;
    },
  });
  const call = (name, event = {}) => handlers[name]?.(event, {});
  const run = async (action, params = {}) => {
    const result = await tool.execute("call-1", { action, ...params });
    return result.content[0].text;
  };
  return { handlers, tool, call, run };
}

test("ensureJournal writes the heading once", async () => {
  const { file } = await tempJournal();
  ensureJournal(file);
  ensureJournal(file);
  const content = await readFile(file, "utf8");
  assert.equal(content, "# Session Journal\n\nTimes are UTC. One record for each request. Append only.\n");
  assert.equal(content.match(/# Session Journal/g).length, 1);
});

test("openRecord writes the ID, the status, and the request", async () => {
  const { file } = await tempJournal();
  const id = openRecord(file, "Evaluate the migration path for the unit-test job.", AT_0912);
  assert.equal(id, `J-${dayKey(AT_0912)}-01`);

  const content = await readFile(file, "utf8");
  assert.match(content, new RegExp(`^## ${id} — Evaluate the migration path`, "m"));
  assert.match(content, /^- status: open$/m);
  assert.match(content, /^- started: 2026-02-10T09:12:00.000Z$/m);
  assert.match(content, /^- request: Evaluate the migration path for the unit-test job\.$/m);
});

test("record IDs count up for one day and restart on the next day", async () => {
  const { file } = await tempJournal();
  const first = openRecord(file, "first", AT_0912);
  const second = openRecord(file, "second", AT_1130);
  assert.equal(first, `J-${dayKey(AT_0912)}-01`);
  assert.equal(second, `J-${dayKey(AT_0912)}-02`);

  const nextDay = openRecord(file, "third", NEXT_DAY);
  assert.equal(nextDay, `J-${dayKey(NEXT_DAY)}-01`);
  assert.equal(nextRecordId(readJournal(file), NEXT_DAY), `J-${dayKey(NEXT_DAY)}-02`);
});

test("appendEntry appends and keeps the earlier content", async () => {
  const { file } = await tempJournal();
  openRecord(file, "Fix the build", AT_0912);
  const before = readJournal(file);

  appendEntry(file, "plan", ["- Read `.gitlab-ci.yml`."], AT_1130);
  const after = readJournal(file);

  assert.ok(after.startsWith(before), "appendEntry must not change earlier lines");
  assert.match(after, /### 11:30 — plan\n- Read `\.gitlab-ci\.yml`\.\n/);
});

test("setStatus changes one record only", async () => {
  const { file } = await tempJournal();
  const first = openRecord(file, "first task", AT_0912);
  const second = openRecord(file, "second task", AT_1130);

  assert.equal(setStatus(file, first, "done"), true);
  assert.equal(setStatus(file, "J-19700101-01", "done"), false);

  const records = parseRecords(readJournal(file));
  assert.equal(records.find((r) => r.id === first)?.status, "done");
  assert.equal(records.find((r) => r.id === second)?.status, "open");
  assert.match(readJournal(file), new RegExp(`^## ${second} — second task$`, "m"));
});

test("latestActive returns the newest record that is not closed", async () => {
  const { file } = await tempJournal();
  const first = openRecord(file, "first task", AT_0912);
  const second = openRecord(file, "second task", AT_1130);

  assert.equal(latestActive(readJournal(file))?.id, second);
  setStatus(file, second, "handed-over");
  assert.equal(latestActive(readJournal(file))?.id, first);
  setStatus(file, first, "done");
  assert.equal(latestActive(readJournal(file)), undefined);
});

test("resumeText keeps the header and the last entries", async () => {
  const { file } = await tempJournal();
  openRecord(file, "Long task", AT_0912);
  appendEntry(file, "step 1", ["- first"], AT_0912);
  appendEntry(file, "step 2", ["- second"], AT_1130);
  appendEntry(file, "step 3", ["- third"], AT_1500);

  const record = latestActive(readJournal(file));
  const text = resumeText(record, 2);

  assert.match(text, /^- request: Long task$/m);
  assert.match(text, /### 11:30 — step 2/);
  assert.match(text, /### 15:00 — step 3/);
  assert.doesNotMatch(text, /### 09:12 — step 1/);
});

test("sanitize collapses whitespace and truncates", () => {
  assert.equal(sanitize("  a\n b\tc  "), "a b c");
  assert.equal(sanitize("abcdef", 4), "a...");
  assert.equal(sanitize("abcdef", 10), "abcdef");
});

test("redact masks credential shapes", () => {
  assert.equal(redact(`token ghp_${"a".repeat(24)}`), "token gh***");
  assert.equal(redact("PASSWORD=hunter2"), "PASSWORD=***");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer ***");
  assert.equal(redact("no secret here"), "no secret here");
});

test("resolveJournalFile honours NOUS_JOURNAL", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  try {
    process.env.NOUS_JOURNAL = file;
    assert.equal(resolveJournalFile(), file);
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
  assert.equal(basename(resolveJournalFile()), "journal.md");
});

test("the extension records the request, the tool calls, and the answer", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const h = harness();
    assert.deepEqual(await h.call("input", { text: "Fix the failing build", source: "interactive" }), { action: "continue" });

    await h.call("tool_execution_end", {
      toolName: "bash",
      args: { command: "make test" },
      isError: false,
      durationMs: 1200,
    });
    await h.call("tool_execution_end", { toolName: "read", args: { path: "Makefile" }, isError: true });

    await h.call("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "The build passes now." }] }],
    });
    await h.call("agent_settled", { aborted: false });

    const content = readJournal(file);
    assert.match(content, /^- request: Fix the failing build$/m);
    assert.match(content, /### \d\d:\d\d — tool bash\n- `make test` — ok, 1200ms/);
    assert.match(content, /### \d\d:\d\d — tool read\n- `Makefile` — error/);
    assert.match(content, /### \d\d:\d\d — answer\nThe build passes now\./);
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
});

test("the extension skips slash commands, extension messages, and its own tool", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const h = harness();
    await h.call("input", { text: "/model", source: "interactive" });
    await h.call("input", { text: "internal message", source: "extension" });
    assert.equal(existsSync(file), false, "no record is opened for these inputs");

    await h.call("input", { text: "Real task", source: "rpc" });
    const before = readJournal(file);
    await h.call("tool_execution_end", { toolName: "journal", args: { action: "note" }, isError: false });
    assert.equal(readJournal(file), before, "the journal tool does not log itself");
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
});

test("the journal tool adds a note, closes the record, and lists the records", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const h = harness();
    await h.call("input", { text: "Migrate the unit-test job", source: "interactive" });
    const record = latestActive(readJournal(file));

    assert.match(await h.run("note", { text: "Konflux can run pytest in a Tekton task." }), /Added a note/);
    assert.match(readJournal(file), /### \d\d:\d\d — note\nKonflux can run pytest in a Tekton task\./);

    assert.match(await h.run("close", { status: "done", text: "PipelineRun passed." }), new RegExp(`Closed ${record.id} as done`));
    assert.equal(latestActive(readJournal(file)), undefined);
    assert.match(readJournal(file), /^- status: done$/m);

    const list = await h.run("list");
    assert.match(list, new RegExp(`${record.id} \\[done\\] Migrate the unit-test job`));
    assert.equal(recordIndex(readJournal(file)).length, 1);
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
});

test("a new instance resumes the newest open record", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const first = harness();
    await first.call("input", { text: "Analyze the build times", source: "interactive" });
    await first.call("tool_execution_end", { toolName: "bash", args: { command: "kubectl get pipelineruns" }, isError: false });
    const record = latestActive(readJournal(file));

    // A broken session starts again with a new extension instance.
    const second = harness();
    const options = { sections: {} };
    await second.call("before_agent_start", { systemPrompt: "base", systemPromptOptions: options });
    assert.match(options.sections["session-journal-state"], new RegExp(`newest open record is \`${record.id}\``));
    assert.match(options.sections["session-journal-state"], /kubectl get pipelineruns/);

    const resumed = await second.run("resume");
    assert.match(resumed, new RegExp(`Record ${record.id} \\[open\\]`));
    assert.match(resumed, /^- request: Analyze the build times$/m);

    await second.call("session_start", { reason: "startup" });
    assert.match(readJournal(file), /### \d\d:\d\d — session start\n- reason: startup\n- continue: \S+ from the last entry/);
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
});

test("the extension does not write after the record is closed", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const h = harness();
    await h.call("input", { text: "Short task", source: "interactive" });
    await h.run("close", { status: "done", text: "Finished." });
    const before = readJournal(file);

    await h.call("agent_end", { messages: [{ role: "assistant", content: "Done." }] });
    await h.call("agent_settled", { aborted: false });
    await h.call("session_shutdown", { reason: "quit" });

    assert.equal(readJournal(file), before, "a closed record keeps its text");
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
  }
});

test("an aborted run asks the next session to continue", async () => {
  const { file } = await tempJournal();
  const saved = process.env.NOUS_JOURNAL;
  process.env.NOUS_JOURNAL = file;
  try {
    const h = harness();
    await h.call("input", { text: "Long task", source: "interactive" });
    await h.call("agent_settled", { aborted: true });
    assert.match(readJournal(file), /### \d\d:\d\d — run stopped\n- The user stopped the run\. Continue from the last entry\./);
  } finally {
    if (saved === undefined) delete process.env.NOUS_JOURNAL;
    else process.env.NOUS_JOURNAL = saved;
    await rm(file, { force: true });
  }
});
