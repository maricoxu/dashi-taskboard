import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexApiSimulator } from "./harness/codex-api-simulator.mjs";
import { ResourceSampler } from "./harness/resource-sampler.mjs";

test("Codex app-server stage transitions remain valid over repeated API cycles", async () => {
  const simulator = new CodexApiSimulator();
  const resources = new ResourceSampler();
  const started = await simulator.request("thread/start", { cwd: "/workspace", model: "harness-model" });
  const threadId = started.thread.id;
  for (let cycle = 0; cycle < 30; cycle += 1) {
    resources.sample();
    await simulator.request("thread/resume", { threadId });
    const turn = await simulator.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `stage-cycle-${cycle}` }],
    });
    const completed = await simulator.waitForTurn(turn.turn.id);
    assert.equal(completed.status, "completed");
    const read = await simulator.request("thread/read", { threadId });
    assert.equal(read.thread.id, threadId);
    assert.equal(read.thread.turns.length, cycle + 1);
  }
  const report = resources.report();
  assert.equal(report.gpu.memoryBytes === null || Number.isFinite(report.gpu.memoryBytes), true);
  assert.ok(report.rssPeakBytes - report.rssStartBytes < 256 * 1024 * 1024);
  const protocol = simulator.assertProtocol();
  assert.deepEqual(protocol.methods.sort(), ["thread/read", "thread/resume", "thread/start", "turn/start"].sort());
  assert.equal(simulator.calls.length, 1 + 30 * 3);
});

test("Codex interrupt is observable and leaves the thread reusable", async () => {
  const simulator = new CodexApiSimulator({
    turnPlan: async () => new Promise(() => {}),
  });
  const { thread } = await simulator.request("thread/start", { cwd: "/workspace" });
  const { turn } = await simulator.request("turn/start", { threadId: thread.id, input: [] });
  const interrupted = await simulator.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  assert.equal(interrupted.turn.status, "interrupted");
  const resumed = await simulator.request("thread/resume", { threadId: thread.id });
  assert.equal(resumed.thread.status, "idle");
});
