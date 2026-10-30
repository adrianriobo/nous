import test from "node:test";
import assert from "node:assert/strict";
import { registerRouter, hasWritten, isTrivial, isVeryComplex, paidEscalation } from "../context/router/model.ts";
import { MODEL_IDS, TIER_CANDIDATES } from "../context/router/enmaas.ts";

const [flash, glm, mini, terra] = TIER_CANDIDATES.map((tier) => tier.id);
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolCall = (name, type = "toolCall") => ({ role: "assistant", content: [{ type, name, id: "1", arguments: {} }] });
const previous = (id, provider = "enmaas") => ({ model: { provider, id }, thinkingLevel: "off" });
const complexText = `Migrate the build pipeline across the codebase and review the architecture and security review items. ${"detail ".repeat(120)}`;

function harness({ tiers = TIER_CANDIDATES, available = tiers.map((tier) => tier.id), escalation } = {}) {
  const saved = process.env.NOUS_PAID_ESCALATION;
  if (escalation === undefined) delete process.env.NOUS_PAID_ESCALATION;
  else process.env.NOUS_PAID_ESCALATION = escalation;
  let definition;
  let status;
  try {
    registerRouter({
      registerVirtualModel: (value) => { definition = value; },
      ui: { setStatus: (_key, value) => { status = value; } },
    }, tiers);
  } finally {
    if (saved === undefined) delete process.env.NOUS_PAID_ESCALATION;
    else process.env.NOUS_PAID_ESCALATION = saved;
  }
  const context = { modelRegistry: { find: (provider, id) => available.includes(id) ? { provider, id } : undefined } };
  const route = (values = {}) => definition.route({ reason: "user", messages: [user("Analyze the code")], thinkingLevel: "off", ...values }, context);
  return { route, definition, status: () => status };
}

test("auto uses GLM for planning", async () => {
  const h = harness();
  const result = await h.route();
  assert.equal(h.definition.provider, "router");
  assert.equal(h.definition.id, "auto");
  assert.equal(result.model.id, MODEL_IDS.reviewer);
  assert.deepEqual(result.state, { phase: "plan", tier: 1 });
  assert.match(h.status(), /\[plan\] \(plan\)/);
});

test("trivial requests use DeepSeek", async () => {
  const h = harness();
  const result = await h.route({ messages: [user("hello")] });
  assert.equal(result.model.id, MODEL_IDS.scout);
  assert.deepEqual(result.state, { phase: "plan", tier: 0 });
  assert.equal(isTrivial([user("hello")]), true);
  assert.equal(isTrivial([user("explain this code")]), false);
});

test("write tool calls switch this turn to the hosted implementation model", async () => {
  const h = harness();
  for (const [name, type] of [["edit", "toolCall"], ["write", "toolCall"], ["bash", "toolCall"], ["edit", "tool_use"]]) {
    const messages = [user("Update the code"), toolCall(name, type)];
    const result = await h.route({ reason: "continuation", messages, previous: previous(glm), state: { phase: "plan", tier: 1 } });
    assert.equal(result.model.id, flash);
    assert.deepEqual(result.state, { phase: "implement", tier: 0 });
  }
  const continuation = await h.route({ reason: "continuation", previous: previous(flash), state: { phase: "implement", tier: 0 } });
  assert.equal(continuation.model.id, flash);
});

test("historical writes do not switch a new user turn to implementation", async () => {
  const h = harness();
  const messages = [user("First task"), toolCall("edit"), user("Analyze this new task"), toolCall("read")];
  assert.equal(hasWritten(messages), false);
  const start = await h.route({ messages, state: { phase: "implement", tier: 0 } });
  assert.equal(start.model.id, glm);
  const next = await h.route({ reason: "continuation", messages, previous: previous(glm), state: start.state });
  assert.equal(next.model.id, glm);
  assert.equal(next.state.phase, "plan");
});

test("read-only continuations keep the chosen model", async () => {
  const h = harness();
  const result = await h.route({ reason: "continuation", messages: [user("Inspect code"), toolCall("read")], previous: previous(glm), state: { phase: "plan", tier: 1 } });
  assert.equal(result.model.id, glm);
  assert.equal(result.state.tier, 1);
});

test("hosted candidates respect discovery and registry availability", async () => {
  const noGlm = harness({ tiers: TIER_CANDIDATES.filter((tier) => tier.id !== glm) });
  assert.equal((await noGlm.route()).model.id, flash);
  const noFlash = harness({ tiers: TIER_CANDIDATES.filter((tier) => tier.id !== flash) });
  assert.equal((await noFlash.route({ messages: [user("hello")] })).model.id, glm);
  const notInRegistry = harness({ available: [flash, mini, terra] });
  assert.equal((await notInRegistry.route()).model.id, flash);
  const unavailable = harness({ available: [mini, terra] });
  await assert.rejects(async () => unavailable.route(), /No hosted model/);
  await assert.rejects(async () => unavailable.route({ messages: [user("hello")] }), /No hosted model/);
  assert.throws(() => registerRouter({ registerVirtualModel() {} }, []), /No model tiers/);
});

test("automatic retries move between hosted models", async () => {
  const h = harness();
  const first = await h.route({ reason: "retry", state: { phase: "plan", tier: 0 }, failed: previous(flash) });
  assert.equal(first.model.id, glm);
  assert.equal(first.state.tier, 1);
  const second = await h.route({ reason: "retry", state: first.state, failed: previous(glm) });
  assert.equal(second.model.id, mini);
  assert.deepEqual(second.state, { phase: "plan", tier: 2 });
});

test("retry uses the failed model over stale state and skips unavailable tiers", async () => {
  const h = harness({ available: [flash, glm, terra] });
  const result = await h.route({ reason: "retry", state: { phase: "plan", tier: 0 }, failed: previous(glm) });
  assert.equal(result.model.id, terra);
  const noGlm = harness({ available: [flash, mini, terra] });
  assert.equal((await noGlm.route({ reason: "retry", state: { phase: "plan", tier: 0 }, failed: previous(flash) })).model.id, mini);
  const none = harness({ available: [mini, terra] });
  assert.equal((await none.route({ reason: "retry", failed: previous(glm) })).model.id, mini);
});

test("manual levels select configured tiers and preserve paid model on retry", async () => {
  const h = harness();
  assert.equal((await h.route({ thinkingLevel: "low" })).model.id, flash);
  assert.equal((await h.route({ thinkingLevel: "medium" })).model.id, glm);
  const manual = await h.route({ thinkingLevel: "high" });
  assert.equal(manual.model.id, terra);
  const continued = await h.route({ reason: "continuation", previous: previous(terra), state: manual.state, messages: [user("Inspect"), toolCall("read")] });
  assert.equal(continued.model.id, terra);
  const retried = await h.route({ reason: "retry", thinkingLevel: "high", failed: previous(mini), state: { phase: "plan", tier: 2 } });
  assert.equal(retried.model.id, mini);
  const afterEdit = await h.route({ reason: "continuation", previous: previous(terra), state: manual.state, messages: [user("Update"), toolCall("edit")] });
  assert.equal(afterEdit.model.id, flash);
});

test("missing selected tier fails without choosing another paid model", async () => {
  const h = harness({ available: [flash, glm, mini] });
  await assert.rejects(async () => h.route({ thinkingLevel: "high" }), /selected model tier 3 is unavailable/);
  await assert.rejects(async () => h.route({ reason: "retry", thinkingLevel: "high", failed: previous(terra), state: { phase: "plan", tier: 3 } }), /unavailable/);
});

test("direct requests preserve the previous model or use hosted planning", async () => {
  const h = harness();
  assert.equal((await h.route({ reason: "direct" })).model.id, glm);
  const result = await h.route({ reason: "direct", previous: { ...previous(terra), thinkingLevel: "high" } });
  assert.equal(result.model.id, terra);
  assert.equal(result.thinkingLevel, "high");
});

test("very complex requests escalate to a paid model without a dialog", async () => {
  const h = harness();
  const first = await h.route({ messages: [user(complexText)] });
  assert.equal(first.model.id, mini);
  assert.deepEqual(first.state, { phase: "plan", tier: 2 });
  assert.match(h.status(), /complex→paid/);
  const readOnly = await h.route({ reason: "continuation", previous: previous(mini), state: first.state, messages: [user("Inspect"), toolCall("read")] });
  assert.equal(readOnly.model.id, mini);
  const implementation = await h.route({ reason: "continuation", previous: previous(mini), state: readOnly.state, messages: [user("Update"), toolCall("edit")] });
  assert.equal(implementation.model.id, flash);
});

test("hosted exhaustion escalates to paid tiers in order", async () => {
  const h = harness();
  const first = await h.route({ reason: "retry", failed: previous(glm), state: { phase: "plan", tier: 1 } });
  assert.equal(first.model.id, mini);
  assert.match(h.status(), /retry→paid/);
  const second = await h.route({ reason: "retry", failed: previous(mini), state: first.state });
  assert.equal(second.model.id, terra);
  const third = await h.route({ reason: "retry", failed: previous(terra), state: second.state });
  assert.equal(third.model.id, terra);
  assert.match(h.status(), /retry paid/);
});

test("a manual paid model keeps its tier on retry", async () => {
  const h = harness();
  const result = await h.route({ reason: "retry", failed: previous(mini), state: { phase: "plan", tier: 2 } });
  assert.equal(result.model.id, terra);
  const manual = await h.route({ reason: "retry", thinkingLevel: "high", failed: previous(terra), state: { phase: "plan", tier: 3 } });
  assert.equal(manual.model.id, terra);
});

test("NOUS_PAID_ESCALATION=off keeps automatic routing on hosted models", async () => {
  assert.equal(paidEscalation(), true);
  process.env.NOUS_PAID_ESCALATION = "off";
  assert.equal(paidEscalation(), false);
  delete process.env.NOUS_PAID_ESCALATION;

  const h = harness({ escalation: "off" });
  const complex = await h.route({ messages: [user(complexText)] });
  assert.equal(complex.model.id, glm);
  const retry = await h.route({ reason: "retry", failed: previous(glm), state: { phase: "plan", tier: 1 } });
  assert.equal(retry.model.id, glm);
  const manual = await h.route({ thinkingLevel: "high" });
  assert.equal(manual.model.id, terra);
});

test("escalation skips paid tiers that the registry does not list", async () => {
  const h = harness({ available: [flash, glm, terra] });
  const result = await h.route({ messages: [user(complexText)] });
  assert.equal(result.model.id, terra);
  const unavailable = harness({ available: [flash, glm] });
  const hosted = await unavailable.route({ messages: [user(complexText)] });
  assert.equal(hosted.model.id, glm);
});

test("complexity detection needs length and scope signals", () => {
  assert.equal(isVeryComplex([user(complexText)]), true);
  assert.equal(isVeryComplex([user("Fix the bug in a.ts")]), false);
  assert.equal(isVeryComplex([user(`${"word ".repeat(130)}`) ]), false);
  assert.equal(isVeryComplex([user(`${"Migrate and review the architecture across the codebase. ".repeat(20)}`)]), true);
  assert.equal(isVeryComplex([user(`Read a.ts, b.ts, c.ts, d.ts and explain each file. ${"word ".repeat(60)}`)]), true);
});
