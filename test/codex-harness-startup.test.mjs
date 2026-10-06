import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskboardHarness } from "./harness/taskboard-harness.mjs";
import { RendererHarness } from "./harness/renderer-harness.mjs";

test("Taskboard startup, authenticated health, display mount and release survive ten cycles", async () => {
  const renderer = new RendererHarness();
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const harness = await createTaskboardHarness();
    try {
      const health = await harness.health();
      assert.equal(health.status, "ok");
      assert.equal(health.product, "codex-taskboard");
      assert.equal(health.version, "harness");
      assert.equal(health.proofMatches, true);
      renderer.mount();
      renderer.assertReady();
      const projects = await harness.request("/api/projects");
      assert.equal(projects.response.status, 200);
      renderer.unmount();
      assert.equal(renderer.state, "closed");
    } finally {
      await harness.close();
    }
  }
  assert.equal(renderer.mountCount, 10);
  assert.equal(renderer.unmountCount, 10);
});

test("renderer crash recovery remounts the dashboard without leaking a second frame", () => {
  const renderer = new RendererHarness();
  renderer.mount();
  renderer.crash();
  assert.throws(() => renderer.assertReady(), /crashed/);
  renderer.recover();
  renderer.assertReady();
  renderer.unmount();
  assert.equal(renderer.mountCount, 1);
  assert.equal(renderer.recoveryCount, 1);
});
