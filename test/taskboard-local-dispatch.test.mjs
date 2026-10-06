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
    if (pathname === "/api/tasks?projectId=local") return { tasks };
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
    waitForTurn: undefined,
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
    if (pathname === "/api/tasks?projectId=local") return { tasks: [item] };
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

test("a legacy shared binding creates an independent thread", async () => {
  const first = task("5");
  const second = task("6");
  const shared = {
    threadId: "shared-thread",
    codexProjectId: "project-local",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/workspace",
  };
  first.status = "in_progress";
  first.threadId = shared.threadId;
  first.threadBinding = shared;
  const tasks = [first, second];
  const calls = [];
  const taskboardRequest = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/api/tasks?projectId=local&status=todo") return { tasks: [second] };
    if (pathname === "/api/tasks?projectId=local") return { tasks };
    if (pathname.endsWith("/comments")) return { comments: [] };
    if (pathname.endsWith("/move")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      Object.assign(second, body, { version: second.version + 1 });
      return { task: second };
    }
    return { task: second };
  };
  const rpc = async (_hostId, method) => {
    if (method === "thread/start") return { thread: { id: "独立-thread" } };
    if (method === "turn/start") return { turn: { id: "独立-turn" } };
    throw new Error(`unexpected ${method}`);
  };
  await dispatchLocalTodos(request, { request: taskboardRequest, rpc, stillCurrent: () => true });
  assert.equal(second.threadId, "独立-thread");
  assert.equal(calls.some((call) => call.method === "thread/resume"), false);
});

test("a completed turn writes evidence and moves the task to review", async () => {
  const item = task("7");
  const comments = [];
  const taskboardRequest = async (pathname, options = {}) => {
    if (pathname === "/api/tasks?projectId=local&status=todo") return { tasks: [item] };
    if (pathname === "/api/tasks?projectId=local") return { tasks: [item] };
    if (pathname.endsWith("/comments")) {
      if (options.method === "POST") comments.push(typeof options.body === "string" ? JSON.parse(options.body) : options.body);
      return { comments };
    }
    if (pathname.endsWith("/move")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      Object.assign(item, body, { version: item.version + 1 });
      return { task: item };
    }
    return { task: item };
  };
  const rpc = async (_hostId, method) => method === "thread/start"
    ? { thread: { id: "thread-7" } }
    : { turn: { id: "turn-7" } };
  const waitForTurn = {
    prepare() {
      return { wait: async () => ({ status: "completed", items: [{ type: "agentMessage", text: "done" }] }) };
    },
  };
  const result = await dispatchLocalTodos(request, { request: taskboardRequest, rpc, waitForTurn, stillCurrent: () => true });
  assert.equal(result[0].state, "in_review");
  assert.equal(item.status, "in_review");
  assert.match(comments[0].body, /done/);
});

test("an expired saved binding is replaced immediately", async () => {
  const item = task("8");
  item.threadBinding = {
    threadId: "expired-thread",
    codexProjectId: "project-local",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/workspace",
  };
  const calls = [];
  const taskboardRequest = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/api/tasks?projectId=local&status=todo") return { tasks: [item] };
    if (pathname === "/api/tasks?projectId=local") return { tasks: [item] };
    if (pathname.endsWith("/comments")) return { comments: [] };
    if (pathname.endsWith("/move")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      Object.assign(item, body, { version: item.version + 1 });
      return { task: item };
    }
    return { task: item };
  };
  const rpcMethods = [];
  const rpc = async (_hostId, method) => {
    rpcMethods.push(method);
    if (method === "thread/resume") throw new Error("no rollout found for thread id expired-thread");
    if (method === "thread/start") return { thread: { id: "fresh-thread" } };
    if (method === "turn/start") return { turn: { id: "fresh-turn" } };
    throw new Error(`unexpected ${method}`);
  };
  const result = await dispatchLocalTodos(request, { request: taskboardRequest, rpc, stillCurrent: () => true });
  assert.equal(result[0].state, "started");
  assert.equal(item.threadId, "fresh-thread");
  assert.equal(rpcMethods.includes("thread/resume"), true);
});

test("local automation can return after turn/start and reconcile in the background", async () => {
  const item = task("9");
  const taskboardRequest = async (pathname, options = {}) => {
    if (pathname === "/api/tasks?projectId=local&status=todo") return { tasks: [item] };
    if (pathname === "/api/tasks?projectId=local") return { tasks: [item] };
    if (pathname.endsWith("/comments")) return { comments: [] };
    if (pathname.endsWith("/move")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      Object.assign(item, body, { version: item.version + 1 });
      return { task: item };
    }
    return { task: item };
  };
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const rpc = async (_hostId, method) => method === "thread/start"
    ? { thread: { id: "thread-9" } }
    : { turn: { id: "turn-9" } };
  const waitForTurn = {
    awaitCompletion: false,
    prepare() { return { wait: () => completion }; },
  };
  const result = await dispatchLocalTodos(request, { request: taskboardRequest, rpc, waitForTurn, stillCurrent: () => true });
  assert.equal(result[0].state, "started");
  assert.equal(item.status, "in_progress");
  resolveCompletion({ status: "completed", items: [{ type: "agentMessage", text: "background done" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(item.status, "in_review");
});
