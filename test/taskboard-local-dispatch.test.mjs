import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchLocalTodos } from "../scripts/taskboard-local-dispatch.mjs";

const request = {
  taskboardProjectId: "local",
  codexProjectId: "project-local",
  codexProjectKind: "local",
  codexHostId: "local",
  workspacePath: "/workspace",
  model: "gpt-6-astra",
  reasoningEffort: "high",
};

function task(id, version = 1) {
  return {
    id,
    identifier: `LOCAL-${id}`,
    title: `Task ${id}`,
    description: "Run the requested work.",
    projectId: "local",
    status: "todo",
    archivedAt: null,
    version,
    threadId: null,
    threadBinding: null,
    relations: { blockedBy: [] },
  };
}

test("local dispatch continues after one task fails and starts later todos", async () => {
  const tasks = [task("1"), task("2"), task("3")];
  const comments = new Map(tasks.map((item) => [item.id, []]));
  const calls = [];
  let nextThread = 1;
  const taskboardRequest = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/api/tasks?projectId=local&status=todo") {
      return { tasks: tasks.filter((item) => item.status === "todo") };
    }
    const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(comments|move))?$/);
    assert.ok(match, pathname);
    const item = tasks.find((candidate) => candidate.id === decodeURIComponent(match[1]));
    assert.ok(item, pathname);
    if (match[2] === "comments") return { comments: comments.get(item.id) };
    if (match[2] === "move") {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      assert.equal(body.version, item.version);
      if (item.id === "2") throw new Error("simulated move failure");
      Object.assign(item, body, { version: item.version + 1 });
      return { task: item };
    }
    return { task: item };
  };
  const rpc = async (_hostId, method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${nextThread++}` } };
    if (method === "turn/start") return { turn: { id: `turn-${params.threadId}` } };
    throw new Error(`unexpected ${method}`);
  };

  const result = await dispatchLocalTodos(request, {
    request: taskboardRequest,
    rpc,
    stillCurrent: () => true,
  });

  assert.deepEqual(result.map((item) => [item.identifier, item.state]), [
    ["LOCAL-1", "started"],
    ["LOCAL-2", "failed"],
    ["LOCAL-3", "started"],
  ]);
  assert.equal(tasks[0].status, "in_progress");
  assert.equal(tasks[1].status, "todo");
  assert.equal(tasks[2].status, "in_progress");
});

test("local dispatch blocks a task after ownership when its turn fails", async () => {
  const item = task("4");
  const comments = [];
  const taskboardRequest = async (pathname, options = {}) => {
    if (pathname === "/api/tasks?projectId=local&status=todo") return { tasks: [item] };
    if (pathname.endsWith("/comments")) {
      if (options.method === "POST") comments.push(
        typeof options.body === "string" ? JSON.parse(options.body) : options.body,
      );
      return { comments };
    }
    if (pathname.endsWith("/move")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      assert.equal(body.version, item.version);
      Object.assign(item, body, { version: item.version + 1 });
      return { task: item };
    }
    return { task: item };
  };
  const rpc = async (_hostId, method) => {
    if (method === "thread/start") return { thread: { id: "thread-4" } };
    throw new Error("turn failed");
  };

  const result = await dispatchLocalTodos(request, {
    request: taskboardRequest,
    rpc,
    stillCurrent: () => true,
  });

  assert.equal(result[0].state, "blocked");
  assert.equal(item.status, "blocked");
  assert.match(comments[0].body, /turn failed/);
});
