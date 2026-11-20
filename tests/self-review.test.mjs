import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerSelfReview from "../context/self-review/index.ts";
import {
  MODE_VARIABLE,
  REMINDER_TYPE,
  looksMutating,
  needsReminder,
  readSnapshot,
  reviewEnabled,
  startRun,
} from "../context/self-review/state.ts";

const CLEAN = { head: "aaa", status: "" };

function harness() {
  const handlers = {};
  registerSelfReview({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const call = (name, event = {}, ctx = { cwd: tmpdir() }) => handlers[name]?.(event, ctx);
  return { handlers, call };
}

async function tempDir() {
  return await mkdtemp(join(tmpdir(), "nous-self-review-"));
}

// A repository with one commit on `main`.
async function tempRepo() {
  const dir = await tempDir();
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "one");
  return { dir, git };
}

// The settle result carries the reminder only when the extension decided to.
function reminderOf(result) {
  if (!result) return null;
  const entries = result.entries ?? [];
  const mine = entries.filter((entry) => entry.customType === REMINDER_TYPE);
  return mine.length === 1 && result.continue === true ? mine[0] : null;
}

test("reviewEnabled is on by default and off only for the off value", () => {
  assert.equal(reviewEnabled({}), true);
  assert.equal(reviewEnabled({ [MODE_VARIABLE]: "auto" }), true);
  assert.equal(reviewEnabled({ [MODE_VARIABLE]: " OFF " }), false);
  assert.equal(reviewEnabled({ [MODE_VARIABLE]: "off" }), false);
});

test("readSnapshot returns null outside a Git repository", async () => {
  const dir = await tempDir();
  try {
    assert.equal(readSnapshot(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSnapshot reads HEAD and the working tree", async () => {
  const { dir } = await tempRepo();
  try {
    const clean = readSnapshot(dir);
    assert.match(clean.head, /^[0-9a-f]{40}$/);
    assert.equal(clean.status, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotChanged ignores two unknown baselines", () => {
  const state = startRun(null);
  assert.equal(needsReminder(state, null), false);
});

test("a run with no change and no review adds no reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Explain the router" });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("a dirty baseline adds no reminder when the run adds no file", async () => {
  const { dir } = await tempRepo();
  try {
    // A file changed in an earlier session, before the run started.
    await writeFile(join(dir, "a.txt"), "two\n");
    const { call } = harness();
    await call("input", { text: "Read the file" }, { cwd: dir });
    assert.equal(reminderOf(await call("agent_before_settle", {}, { cwd: dir })), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an edit without a review adds one reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });

  const reminder = reminderOf(await call("agent_before_settle"));
  assert.ok(reminder, "the extension must add a reminder");
  assert.equal(reminder.type, "custom_message");
  assert.equal(reminder.display, false);
  assert.match(reminder.content, /changed files and no review ran/);
  assert.match(reminder.content, /repo-relative paths/);
});

test("a write without a review adds one reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Add the file" });
  await call("tool_execution_end", { toolName: "write", isError: false });
  assert.ok(reminderOf(await call("agent_before_settle")));
});

test("a review after the change adds no reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });
  await call("tool_execution_end", { toolName: "code_review", isError: false });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("a failed review call does not count as a review", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });
  await call("tool_execution_end", { toolName: "code_review", isError: true });
  assert.ok(reminderOf(await call("agent_before_settle")));
});

test("a failed edit does not count as a change", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: true });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("the reminder does not repeat in the same run", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });

  assert.ok(reminderOf(await call("agent_before_settle")));
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("NOUS_SELF_REVIEW=off disables the reminder", async () => {
  const previous = process.env[MODE_VARIABLE];
  process.env[MODE_VARIABLE] = "off";
  try {
    const { call } = harness();
    await call("input", { text: "Fix the bug" });
    await call("tool_execution_end", { toolName: "edit", isError: false });
    assert.equal(reminderOf(await call("agent_before_settle")), null);
  } finally {
    if (previous === undefined) delete process.env[MODE_VARIABLE];
    else process.env[MODE_VARIABLE] = previous;
  }
});

test("a new request opens a new run and clears the earlier change", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });

  await call("input", { text: "Now explain the router" });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("an input from an extension keeps the current run", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });
  await call("input", { text: "Question from a subagent", source: "extension" });
  assert.ok(reminderOf(await call("agent_before_settle")));
});

test("a slash command keeps the current run", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });
  await call("input", { text: "/model" });
  assert.ok(reminderOf(await call("agent_before_settle")));
});

test("the bash heuristic finds a mutating command", () => {
  assert.equal(looksMutating("sed -i 's/a/b/' file.ts"), true);
  assert.equal(looksMutating("rm -f out.tar"), true);
  assert.equal(looksMutating("git commit -m 'fix'"), true);
  assert.equal(looksMutating("tar xf archive.tar"), false);
  assert.equal(looksMutating("ls -la"), false);
  assert.equal(looksMutating("git status --porcelain"), false);
  assert.equal(looksMutating(undefined), false);
});

test("a mutating shell command outside a repository adds a reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Patch the file" });
  await call("tool_execution_end", {
    toolName: "bash",
    isError: false,
    args: { command: "sed -i 's/a/b/' notes.txt" },
  });
  assert.ok(reminderOf(await call("agent_before_settle")));
});

test("a read-only shell command outside a repository adds no reminder", async () => {
  const { call } = harness();
  await call("input", { text: "Look at the file" });
  await call("tool_execution_end", {
    toolName: "bash",
    isError: false,
    args: { command: "cat notes.txt" },
  });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("a new file in the repository adds a reminder", async () => {
  const { dir } = await tempRepo();
  try {
    const { call } = harness();
    await call("input", { text: "Add a file" }, { cwd: dir });
    await writeFile(join(dir, "b.txt"), "new\n");
    assert.ok(reminderOf(await call("agent_before_settle", {}, { cwd: dir })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new commit adds a reminder even when the tree is clean", async () => {
  const { dir, git } = await tempRepo();
  try {
    const { call } = harness();
    await call("input", { text: "Commit the change" }, { cwd: dir });
    await writeFile(join(dir, "a.txt"), "two\n");
    git("add", ".");
    git("commit", "-qm", "two");
    assert.equal(readSnapshot(dir).status, "");
    assert.ok(reminderOf(await call("agent_before_settle", {}, { cwd: dir })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read-only run in the repository adds no reminder", async () => {
  const { dir } = await tempRepo();
  try {
    const { call } = harness();
    await call("input", { text: "Read the file" }, { cwd: dir });
    await call("tool_execution_end", { toolName: "read", isError: false });
    assert.equal(reminderOf(await call("agent_before_settle", {}, { cwd: dir })), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a handler error does not stop the run and logs one line", async () => {
  const { call } = harness();
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const ctx = {
      get cwd() {
        throw new Error("boom");
      },
    };
    const result = await call("agent_before_settle", { entries: [] }, ctx);
    assert.equal(result, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[self-review\] agent_before_settle: boom$/);
  } finally {
    console.error = original;
  }
});

test("the reminder keeps the entries that other extensions proposed", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });

  const earlier = { type: "custom_message", customType: "other", content: "keep me", display: false };
  const result = await call("agent_before_settle", { entries: [earlier] });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0], earlier);
  assert.ok(reminderOf(result));
});

test("the settled hook clears the run", async () => {
  const { call } = harness();
  await call("input", { text: "Fix the bug" });
  await call("tool_execution_end", { toolName: "edit", isError: false });
  await call("agent_settled", { aborted: false });
  assert.equal(reminderOf(await call("agent_before_settle")), null);
});

test("a clean run keeps the CLEAN fixture free of a change", () => {
  const state = startRun(CLEAN);
  assert.equal(needsReminder(state, CLEAN), false);
  assert.equal(needsReminder(state, { head: "bbb", status: "" }), true);
  assert.equal(needsReminder(state, { head: "aaa", status: " M a.txt" }), true);
});
