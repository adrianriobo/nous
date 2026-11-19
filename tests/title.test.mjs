import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import registerTitle from "../context/title/index.ts";

const SESSION = "probe";
const CWD = basename(process.cwd());
const PI_DEFAULT = `π - ${SESSION} - ${CWD}`;

/**
 * Build a fake pi runtime and a fake UI context.
 * The harness records the titles and the notifications.
 */
function harness() {
  const handlers = {};
  const commands = {};
  const titles = [];
  const notes = [];

  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: (name, definition) => {
      commands[name] = definition;
    },
    getSessionName: () => SESSION,
  };

  const ctx = {
    ui: {
      setTitle: (title) => titles.push(title),
      notify: (message) => notes.push(message),
    },
  };

  registerTitle(pi);

  return {
    pi,
    ctx,
    titles,
    notes,
    commands,
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    infoChanged: () => handlers.session_info_changed({ name: SESSION }, ctx),
    command: (args) => commands.title.handler(args, ctx),
  };
}

async function withEnv(value, fn) {
  const previous = process.env.NOUS_TITLE;
  if (value === undefined) delete process.env.NOUS_TITLE;
  else process.env.NOUS_TITLE = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.NOUS_TITLE;
    else process.env.NOUS_TITLE = previous;
  }
}

test("NOUS_TITLE sets the title on session start", async () => {
  await withEnv("nous | RHAII migration", async () => {
    const h = harness();
    await h.start();
    assert.deepEqual(h.titles, ["nous | RHAII migration"]);
  });
});

test("without NOUS_TITLE the extension keeps the pi default", async () => {
  await withEnv(undefined, async () => {
    const h = harness();
    await h.start();
    assert.deepEqual(h.titles, []);
  });
});

test("a blank NOUS_TITLE is ignored", async () => {
  await withEnv("   ", async () => {
    const h = harness();
    await h.start();
    assert.deepEqual(h.titles, []);
  });
});

test("control characters are removed from NOUS_TITLE", async () => {
  await withEnv("line one\nline two\u0007", async () => {
    const h = harness();
    await h.start();
    assert.deepEqual(h.titles, ["line one line two"]);
  });
});

test("/title sets a title that survives a session rename", async () => {
  await withEnv(undefined, async () => {
    const h = harness();
    await h.start();
    await h.command("Release 1.2");
    await h.infoChanged();
    assert.deepEqual(h.titles, ["Release 1.2", "Release 1.2"]);
  });
});

test("/title wins over NOUS_TITLE", async () => {
  await withEnv("from env", async () => {
    const h = harness();
    await h.start();
    await h.command("from command");
    assert.deepEqual(h.titles, ["from env", "from command"]);
  });
});

test("/title reset returns to NOUS_TITLE", async () => {
  await withEnv("from env", async () => {
    const h = harness();
    await h.start();
    await h.command("from command");
    await h.command("reset");
    assert.equal(h.titles.at(-1), "from env");
  });
});

test("/title reset without NOUS_TITLE returns the pi default", async () => {
  await withEnv(undefined, async () => {
    const h = harness();
    await h.start();
    await h.command("from command");
    await h.command("reset");
    assert.equal(h.titles.at(-1), PI_DEFAULT);
  });
});

test("/title without arguments reports the current source", async () => {
  await withEnv(undefined, async () => {
    const h = harness();
    await h.start();
    await h.command("");
    assert.deepEqual(h.titles, []);
    assert.deepEqual(h.notes, ["Window title: pi default"]);
  });
});
