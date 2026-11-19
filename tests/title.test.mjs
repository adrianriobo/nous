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
    shutdown: (reason) => handlers.session_shutdown({ reason }, ctx),
    command: (args) => commands.title.handler(args, ctx),
  };
}

/** Key of the stdout wrapper inside the extension. */
const INTERCEPTOR = Symbol.for("nous.title.interceptor");

/**
 * Replace process.stdout.write with a recorder. The extension wraps this
 * function at load. The teardown removes the wrapper and restores the real
 * write function.
 */
async function withStdoutSpy(fn) {
  const original = process.stdout.write;
  const writes = [];
  // Drop the wrapper that an earlier case left behind. The extension then
  // installs a new wrapper around the recorder.
  delete globalThis[INTERCEPTOR];
  process.stdout.write = (chunk) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    await fn(writes);
  } finally {
    delete globalThis[INTERCEPTOR];
    process.stdout.write = original;
  }
}

/** Escape sequence that pi writes for its own title. */
function piTitleSequence(title = PI_DEFAULT, command = "0") {
  return `\u001b]${command};${title}\u0007`;
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

// The cases below cover the startup race described in the header of the
// extension: pi writes its own title after the session_start handler.

test("the pi title after session_start keeps the NOUS_TITLE value", async () => {
  await withEnv("nous | RHAII migration", async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      process.stdout.write(piTitleSequence());
      assert.deepEqual(writes, ["\u001b]0;nous | RHAII migration\u0007"]);
    });
  });
});

test("the pi title passes through without NOUS_TITLE", async () => {
  await withEnv(undefined, async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      process.stdout.write(piTitleSequence());
      assert.deepEqual(writes, [piTitleSequence()]);
    });
  });
});

test("OSC 2 and buffer chunks are rewritten too", async () => {
  await withEnv("from env", async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      process.stdout.write(piTitleSequence(PI_DEFAULT, "2"));
      process.stdout.write(Buffer.from(piTitleSequence()));
      assert.deepEqual(writes, ["\u001b]0;from env\u0007", "\u001b]0;from env\u0007"]);
    });
  });
});

test("output without a title sequence is not changed", async () => {
  await withEnv("from env", async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      process.stdout.write("plain text\n");
      process.stdout.write("\u001b[2K\u001b[1;1Hline\n");
      assert.deepEqual(writes, ["plain text\n", "\u001b[2K\u001b[1;1Hline\n"]);
    });
  });
});

test("/title changes the value that replaces the pi title", async () => {
  await withEnv("from env", async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      await h.command("from command");
      process.stdout.write(piTitleSequence());
      await h.command("reset");
      process.stdout.write(piTitleSequence());
      assert.deepEqual(writes, [
        "\u001b]0;from command\u0007",
        "\u001b]0;from env\u0007",
      ]);
    });
  });
});

test("a second load reuses the wrapper and keeps ownership", async () => {
  await withEnv("from env", async () => {
    await withStdoutSpy(async (writes) => {
      const first = harness();
      await first.start();
      const second = harness();
      await second.start();
      // The old instance must not remove the wrapper of the new one.
      await first.shutdown("reload");
      process.stdout.write(piTitleSequence());
      assert.deepEqual(writes, ["\u001b]0;from env\u0007"]);
    });
  });
});

test("session shutdown on quit removes the wrapper", async () => {
  await withEnv("from env", async () => {
    await withStdoutSpy(async (writes) => {
      const h = harness();
      await h.start();
      await h.shutdown("quit");
      process.stdout.write(piTitleSequence());
      assert.deepEqual(writes, [piTitleSequence()]);
    });
  });
});
