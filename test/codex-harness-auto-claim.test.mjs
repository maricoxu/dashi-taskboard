import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchLocalTodos } from "../scripts/taskboard-local-dispatch.mjs";
import { CodexApiSimulator } from "./harness/codex-api-simulator.mjs";
import { createTaskboardHarness } from "./harness/taskboard-harness.mjs";

async function runDispatch(harness, simulator) {
  const request = {
    taskboardProjectId: "local",
    codexProjectId: "harness-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: harness.directory,
    model: "harness-model",
    reasoningEffort: "high",
  };
  const waitForTurn = {
    prepare(_hostId, threadId) {
      return { wait: (turnId) => simulator.waitForTurn(turnId) };
    },
  };
  return dispatchLocalTodos(request, {
    request: (pathname, options) => harness.request(pathname, options).then((result) => {
      if (!result.response.ok) throw new Error(JSON.stringify(result.body));
      return result.body;
    }),
    rpc: (hostId, method, params) => simulator.request(method, params),
    waitForTurn,
    stillCurrent: () => true,
  });
}

test("auto-claim processes every todo despite waiting words and keeps bindings unique", async () => {
  const harness = await createTaskboardHarness();
  try {
    const tasks = [];
    for (let index = 0; index < 5; index += 1) {
      const task = await harness.createTask(`auto-claim-${index}`, "历史评论包含等待、尚未授权和用户评审字样，但本轮自动化已授权执行");
      tasks.push(task);
      await harness.request(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        body: { body: "等待关键词仅是历史上下文，不应阻止本轮自动认领。" },
      });
    }
    const simulator = new CodexApiSimulator();
    const diagnostics = await runDispatch(harness, simulator);
    assert.equal(diagnostics.length, 5);
    assert.deepEqual(diagnostics.map((item) => item.state), ["in_review", "in_review", "in_review", "in_review", "in_review"]);
    const listed = (await harness.request("/api/tasks?projectId=local&status=in_review")).body.tasks;
    const bindings = listed.filter((task) => tasks.some((item) => item.id === task.id)).map((task) => task.threadBinding.threadId);
    assert.equal(new Set(bindings).size, 5);
  } finally {
    await harness.close();
  }
});

test("one failed auto-claim task becomes blocked while later tasks continue", async () => {
  const harness = await createTaskboardHarness();
  try {
    await harness.createTask("auto-claim-fail", "fail this simulated turn");
    await harness.createTask("auto-claim-after-failure", "continue after a previous failure");
    const simulator = new CodexApiSimulator({
      turnPlan: async ({ turn }) => ({
        status: turn.input.some((item) => item.text.includes("auto-claim-fail")) ? "failed" : "completed",
        items: [{ type: "agentMessage", text: "harness result" }],
      }),
    });
    const diagnostics = await runDispatch(harness, simulator);
    assert.deepEqual(
      Object.fromEntries(diagnostics.map((item) => [item.title, item.state])),
      { "auto-claim-fail": "blocked", "auto-claim-after-failure": "in_review" },
    );
    const listed = (await harness.request("/api/tasks?projectId=local")).body.tasks;
    assert.equal(listed.find((task) => task.title === "auto-claim-fail").status, "blocked");
    assert.equal(listed.find((task) => task.title === "auto-claim-after-failure").status, "in_review");
  } finally {
    await harness.close();
  }
});
