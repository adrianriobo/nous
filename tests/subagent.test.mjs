import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { registerSubagent } from "../context/router/subagent.ts";
import { registerSubagentTools } from "../context/router/subagent-tools.ts";
import { fetchSlackThread } from "../context/router/slack.ts";
import { MODEL_IDS } from "../context/router/enmaas.ts";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createHarness() {
  const handlers = {};
  let tool;
  registerSubagent({ on: (name, fn) => { handlers[name] = fn; }, registerTool: (definition) => { tool = definition; } });
  const ctx = { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => false } };
  return { tool, ctx, start: () => handlers.before_agent_start(), shutdown: () => handlers.session_shutdown() };
}

const port = await freePort();
const home = await mkdtemp(join(tmpdir(), "nous-subagent-test-"));
process.env.HOME = home;
process.env.ENMAAS_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.ENMAAS_API_KEY = "test-key";
const mock = spawn(process.execPath, ["tests/mock-enmaas-server.mjs"], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), MOCK_SCENARIO: "subagent" }, stdio: ["ignore", "pipe", "inherit"],
});
await once(mock.stdout, "data");

// Wiki fixture for the wiki-researcher child.
process.env.WIKI_PATH = join(home, "wiki");
await mkdir(join(process.env.WIKI_PATH, "concepts"), { recursive: true });
await writeFile(
  join(process.env.WIKI_PATH, "concepts", "router.md"),
  "---\ntype: concept\ntitle: Router\ndescription: nous router notes\ntags: [nous]\n---\n\nnous uses a router to select a model tier.\n",
);

// Read-only Slack API mock for the slack-researcher child.
const slackPort = await freePort();
const slackRequests = [];
const slackMock = createHttpServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  slackRequests.push({ url: url.pathname, query: url.search, auth: req.headers.authorization, cookie: req.headers.cookie });
  const authorized = req.headers.authorization === "Bearer xoxc-test" && req.headers.cookie === "d=xoxd-test";
  if (url.pathname !== "/api/conversations.replies") {
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
    return;
  }
  if (!authorized) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    messages: [
      { ts: "1769005300.000000", user: "U12345678", text: "Thread decision: use Konflux." },
      { ts: "1769005400.000000", user: "U87654321", text: "Open question: who owns the fallback registry?" },
    ],
    response_metadata: { next_cursor: "" },
  }));
});
await new Promise((resolve) => slackMock.listen(slackPort, "127.0.0.1", resolve));
process.env.SLACK_API_BASE = `http://127.0.0.1:${slackPort}/api`;
process.env.SLACK_XOXC_TOKEN = "xoxc-test";
process.env.SLACK_XOXD_TOKEN = "xoxd-test";

test.after(async () => {
  mock.kill();
  await once(mock, "close");
  await new Promise((resolve) => slackMock.close(resolve));
  await rm(home, { recursive: true, force: true });
});

test("scout and reviewer use fixed models and read-only tools", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  for (const [role, model] of [["scout", MODEL_IDS.scout], ["reviewer", MODEL_IDS.reviewer]]) {
    const result = await tool.execute("id", { role, task: "Inspect the repository." }, undefined, undefined, ctx);
    assert.equal(result.details.model, model);
    assert.match(result.content[0].text, /MOCK_SUBAGENT_OK/);
    assert.equal(result.usage.input, 20);
    assert.equal(result.details.turns, 2);
    assert.equal(result.usage.output > 0, true);
  }
});

test("paid review requires confirmation and uses Responses API", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const params = { role: "advanced-reviewer", task: "Inspect the repository." };
  await assert.rejects(tool.execute("id", params, undefined, undefined, ctx), /requires interactive/);
  ctx.hasUI = true;
  await assert.rejects(tool.execute("id", params, undefined, undefined, ctx), /not approved/);
  ctx.ui.confirm = async () => true;
  const result = await tool.execute("id", params, undefined, undefined, ctx);
  assert.equal(result.details.model, MODEL_IDS.advancedReviewer);
  assert.equal(result.usage.input, 20);
  assert.match(result.content[0].text, /MOCK_SUBAGENT_OK/);
});

test("invalid roles and tasks fail before spawning", async () => {
  const { tool, ctx } = createHarness();
  await assert.rejects(tool.execute("id", { role: "worker", task: "x" }, undefined, undefined, ctx), /Invalid/);
  await assert.rejects(tool.execute("id", { role: "scout", task: " " }, undefined, undefined, ctx), /Invalid/);
});

test("provider failures are reported as errors", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  await assert.rejects(tool.execute("id", { role: "scout", task: "MOCK_FAILURE" }, undefined, undefined, ctx), /Subagent failed/);
});

test("repeated tool calls reach the child turn limit", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  await assert.rejects(tool.execute("id", { role: "scout", task: "MOCK_LOOP" }, undefined, undefined, ctx), /turn limit/);
});

test("long final answers are truncated", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const result = await tool.execute("id", { role: "scout", task: "MOCK_TRUNCATE" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /\[Result truncated\.\]$/);
  assert.ok(result.content[0].text.length < 33_000);
});

test("oversized child events stop the child", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  await assert.rejects(tool.execute("id", { role: "scout", task: "MOCK_OVERFLOW" }, undefined, undefined, ctx), /size limit/);
});

test("cancellation stops a running child", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const controller = new AbortController();
  const pending = tool.execute("id", { role: "scout", task: "MOCK_HANG" }, controller.signal, undefined, ctx);
  await delay(200);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("session shutdown stops a running child", async () => {
  const { tool, ctx, start, shutdown } = createHarness();
  await start();
  const pending = tool.execute("id", { role: "scout", task: "MOCK_HANG" }, undefined, undefined, ctx);
  await delay(100);
  await shutdown();
  await assert.rejects(pending, /cancelled/);
});

test("concurrency limit rejects excess calls", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const controller = new AbortController();
  const pending = Array.from({ length: 4 }, () => tool.execute("id", { role: "scout", task: "MOCK_HANG" }, controller.signal, undefined, ctx));
  const settled = Promise.allSettled(pending);
  await assert.rejects(tool.execute("id", { role: "scout", task: "x" }, undefined, undefined, ctx), /concurrency limit/);
  controller.abort();
  assert.equal((await settled).every((result) => result.status === "rejected"), true);
});

test("per-prompt call limit resets on a new prompt", async () => {
  const { tool, ctx, start } = createHarness();
  ctx.hasUI = true;
  await start();
  const params = { role: "advanced-reviewer", task: "Inspect." };
  for (let i = 0; i < 8; i++) await assert.rejects(tool.execute("id", params, undefined, undefined, ctx), /not approved/);
  await assert.rejects(tool.execute("id", params, undefined, undefined, ctx), /call limit/);
  await start();
  await assert.rejects(tool.execute("id", params, undefined, undefined, ctx), /not approved/);
});

test("wiki researcher reads the wiki with the free model", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const result = await tool.execute("id", { role: "wiki-researcher", task: "MOCK_WIKI_CHILD Find router notes." }, undefined, undefined, ctx);
  assert.equal(result.details.model, MODEL_IDS.scout);
  assert.equal(result.details.turns, 2);
  assert.match(result.content[0].text, /MOCK_SUBAGENT_OK/);
  assert.match(result.content[0].text, /nous uses a router to select a model tier/);
});

test("slack researcher reads a thread with the free model", async () => {
  const { tool, ctx, start } = createHarness();
  await start();
  const result = await tool.execute("id", { role: "slack-researcher", task: "MOCK_SLACK_CHILD Summarize the thread." }, undefined, undefined, ctx);
  assert.equal(result.details.model, MODEL_IDS.scout);
  assert.match(result.content[0].text, /MOCK_SUBAGENT_OK/);
  assert.match(result.content[0].text, /Thread decision: use Konflux/);
  assert.match(result.content[0].text, /Open question: who owns the fallback registry/);
  assert.equal(slackRequests.at(-1)?.url, "/api/conversations.replies");
  assert.match(slackRequests.at(-1)?.query ?? "", /channel=C08LVA9E1SS/);
});

test("research roles register only read-only tools", () => {
  const namesFor = (role) => {
    const names = [];
    registerSubagentTools({ registerTool: (definition) => names.push(definition.name) }, role);
    return names.sort();
  };
  assert.deepEqual(namesFor("wiki-researcher"), ["wiki_read", "wiki_search"]);
  assert.deepEqual(namesFor("slack-researcher"), ["slack_thread"]);
  assert.deepEqual(namesFor("scout"), []);
});

test("slack reader rejects invalid input and reports auth errors", async () => {
  await assert.rejects(fetchSlackThread("bad-channel", "1769005300.000000"), /channel/i);
  await assert.rejects(fetchSlackThread("C08LVA9E1SS", "not-a-timestamp"), /timestamp/i);
  const saved = process.env.SLACK_XOXC_TOKEN;
  process.env.SLACK_XOXC_TOKEN = "xoxc-wrong";
  try {
    await assert.rejects(fetchSlackThread("C08LVA9E1SS", "1769005300.000000"), /authentication failed/i);
  } finally {
    process.env.SLACK_XOXC_TOKEN = saved;
  }
});
