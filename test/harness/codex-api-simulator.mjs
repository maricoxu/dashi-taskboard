import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const CODEX_APP_SERVER_METHODS = Object.freeze([
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/interrupt",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class CodexApiSimulator extends EventEmitter {
  constructor({ turnPlan = () => ({ status: "completed" }) } = {}) {
    super();
    this.turnPlan = turnPlan;
    this.calls = [];
    this.threads = new Map();
    this.turns = new Map();
  }

  async request(method, params = {}) {
    if (!CODEX_APP_SERVER_METHODS.includes(method)) {
      throw new Error(`Unsupported simulated Codex method: ${method}`);
    }
    this.calls.push({ method, params: clone(params), at: Date.now() });
    if (method === "thread/start") return this.#startThread(params);
    if (method === "thread/resume") return this.#resumeThread(params);
    if (method === "thread/read") return this.#readThread(params);
    if (method === "turn/start") return this.#startTurn(params);
    return this.#interruptTurn(params);
  }

  async waitForTurn(turnId, timeoutMs = 5_000) {
    const existing = this.turns.get(turnId);
    if (existing?.status === "completed" || existing?.status === "failed" || existing?.status === "interrupted") {
      return clone(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("turn:completed", onDone);
        this.removeListener("turn:failed", onDone);
        this.removeListener("turn:interrupted", onDone);
        reject(new Error(`Simulated Codex turn ${turnId} timed out`));
      }, timeoutMs);
      const onDone = (turn) => {
        if (turn.id !== turnId) return;
        clearTimeout(timer);
        this.removeListener("turn:completed", onDone);
        this.removeListener("turn:failed", onDone);
        this.removeListener("turn:interrupted", onDone);
        resolve(clone(turn));
      };
      this.on("turn:completed", onDone);
      this.on("turn:failed", onDone);
      this.on("turn:interrupted", onDone);
    });
  }

  assertProtocol() {
    for (const call of this.calls) {
      if (!CODEX_APP_SERVER_METHODS.includes(call.method)) {
        throw new Error(`Protocol assertion failed for ${call.method}`);
      }
    }
    return { calls: this.calls.length, methods: [...new Set(this.calls.map((call) => call.method))] };
  }

  #startThread(params) {
    const id = params.threadId || randomUUID();
    const thread = {
      id,
      cwd: params.cwd || null,
      model: params.model || null,
      turns: [],
      status: "idle",
    };
    this.threads.set(id, thread);
    return { thread: clone(thread) };
  }

  #resumeThread(params) {
    const thread = this.threads.get(params.threadId);
    if (!thread) {
      const error = new Error(`Thread ${params.threadId} not found`);
      error.code = "THREAD_NOT_FOUND";
      throw error;
    }
    thread.status = "idle";
    return { thread: clone(thread) };
  }

  #readThread(params) {
    const thread = this.threads.get(params.threadId);
    if (!thread) {
      const error = new Error(`Thread ${params.threadId} not found`);
      error.code = "THREAD_NOT_FOUND";
      throw error;
    }
    return { thread: clone(thread) };
  }

  #startTurn(params) {
    const thread = this.threads.get(params.threadId);
    if (!thread) throw new Error(`Thread ${params.threadId} not found`);
    const turn = {
      id: randomUUID(),
      threadId: params.threadId,
      status: "inProgress",
      items: [],
      input: clone(params.input ?? []),
    };
    this.turns.set(turn.id, turn);
    thread.status = "running";
    thread.turns.push(turn);
    this.emit("notification", {
      hostId: "local",
      method: "turn/started",
      params: { threadId: thread.id, turn: clone(turn) },
    });
    void this.#completeTurn(turn, thread);
    return { turn: { id: turn.id, status: "inProgress" } };
  }

  async #completeTurn(turn, thread) {
    await Promise.resolve();
    const plan = await this.turnPlan({ turn: clone(turn), thread: clone(thread) });
    const status = plan?.status || "completed";
    turn.status = status;
    turn.items = clone(plan?.items ?? [
      { type: "agentMessage", text: "simulated Codex completion" },
    ]);
    thread.status = status === "completed" ? "idle" : status;
    this.emit("notification", {
      hostId: "local",
      method: status === "completed" ? "turn/completed" : "turn/failed",
      params: { threadId: thread.id, turn: clone(turn) },
    });
    this.emit(status === "completed" ? "turn:completed" : "turn:failed", clone(turn));
  }

  #interruptTurn(params) {
    const turn = this.turns.get(params.turnId);
    if (!turn) throw new Error(`Turn ${params.turnId} not found`);
    turn.status = "interrupted";
    const thread = this.threads.get(turn.threadId);
    if (thread) thread.status = "idle";
    this.emit("notification", {
      hostId: "local",
      method: "turn/failed",
      params: { threadId: turn.threadId, turn: clone(turn) },
    });
    this.emit("turn:interrupted", clone(turn));
    return { turn: { id: turn.id, status: "interrupted" } };
  }
}
