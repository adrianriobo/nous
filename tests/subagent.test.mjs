import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { registerSubagent } from "../context/router/subagent.ts";
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
test.after(async () => { mock.kill(); await once(mock, "close"); await rm(home, { recursive: true, force: true }); });

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
