import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTaskboardServer } from "../../server/index.mjs";

export async function createTaskboardHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-harness-"));
  const instanceToken = randomUUID();
  const instanceSecret = randomBytes(32).toString("hex");
  const app = createTaskboardServer({
    dataDirectory: directory,
    instanceToken,
    instanceSecret,
    version: "harness",
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}/${instanceToken}`;

  async function request(pathname, options = {}) {
    const response = await fetch(`${origin}${pathname}`, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined || typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : undefined };
  }

  async function health() {
    const challenge = randomBytes(16).toString("hex");
    const result = await request("/health", {
      headers: { "x-codex-taskboard-challenge": challenge },
    });
    const proof = createHmac("sha256", instanceSecret).update(challenge).digest("hex");
    return { ...result.body, proofMatches: result.body?.proof === proof };
  }

  async function createTask(title, description = "") {
    const result = await request("/api/tasks", {
      method: "POST",
      body: { projectId: "local", title, description, status: "todo" },
    });
    if (result.response.status !== 201) throw new Error(JSON.stringify(result.body));
    return result.body.task;
  }

  return {
    directory,
    origin,
    request,
    health,
    createTask,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
