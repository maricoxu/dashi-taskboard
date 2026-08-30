#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultLogFile = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "Codex Taskboard",
  "codex-embed-observer.log",
);

function parseArgs(argv) {
  const options = { port: 9232, logFile: defaultLogFile };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--log-file") options.logFile = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

function timestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function redact(text) {
  return String(text)
    .replace(
      /(https?:\/\/127\.0\.0\.1:\d+)\/[a-f0-9-]{16,128}(?=\/|\?|["'\s]|$)/gi,
      "$1/<redacted>",
    )
    .replace(
      /(CODEX_TASKBOARD_INSTANCE_(?:TOKEN|SECRET)\s*[=:]\s*)[^\s"']+/gi,
      "$1<redacted>",
    );
}

function targetKind(target) {
  if (target.url?.startsWith("app://") || target.title === "ChatGPT") return "codex";
  if (target.url?.includes("127.0.0.1:47823") || target.url?.includes("127.0.0.1:47824")) {
    return "taskboard";
  }
  return null;
}

class Connection {
  constructor(target) {
    this.target = target;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("CDP WebSocket connection failed")); };
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        this.onEvent?.(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP WebSocket closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}

const options = parseArgs(process.argv.slice(2));
await mkdir(path.dirname(options.logFile), { recursive: true });
const file = createWriteStream(options.logFile, { flags: "a", mode: 0o600 });
await new Promise((resolve, reject) => {
  file.once("open", resolve);
  file.once("error", reject);
});

function write(kind, detail) {
  const line = `[${timestamp()}] ${kind} ${redact(JSON.stringify(detail))}`;
  console.log(line);
  file.write(`${line}\n`);
}

const connections = new Map();
const seenTargets = new Set();
let stopping = false;

async function inspectTarget(target) {
  const kind = targetKind(target);
  if (!kind || !target.webSocketDebuggerUrl || connections.has(target.id)) return;
  const connection = new Connection(target);
  try {
    await connection.open();
    connection.onEvent = (message) => {
      if (message.method === "Network.responseReceived") {
        const response = message.params.response;
        const url = response?.url || "";
        if (url.includes("/api/") || url.includes("/events")) {
          write("network.response", {
            kind,
            targetId: target.id,
            status: response.status,
            mimeType: response.mimeType,
            url,
          });
        }
      } else if (message.method === "Network.loadingFailed") {
        if (message.params.canceled && message.params.errorText === "net::ERR_ABORTED") return;
        write("network.failed", {
          kind,
          targetId: target.id,
          errorText: message.params.errorText,
          canceled: message.params.canceled ?? false,
          requestId: message.params.requestId,
        });
      } else if (message.method === "Runtime.exceptionThrown") {
        write("runtime.exception", {
          kind,
          targetId: target.id,
          description: message.params.exceptionDetails?.exception?.description
            || message.params.exceptionDetails?.text
            || "",
        });
      } else if (message.method === "Runtime.consoleAPICalled") {
        write("runtime.console", {
          kind,
          targetId: target.id,
          type: message.params.type,
          args: (message.params.args || []).map((arg) => arg.value ?? arg.description ?? null).slice(0, 8),
        });
      } else if (message.method === "Log.entryAdded") {
        write("browser.log", {
          kind,
          targetId: target.id,
          level: message.params.entry?.level,
          source: message.params.entry?.source,
          text: message.params.entry?.text,
        });
      } else if (message.method === "Page.frameNavigated") {
        write("frame.navigated", {
          kind,
          targetId: target.id,
          frameId: message.params.frame?.id,
          url: message.params.frame?.url,
        });
      }
    };
    await connection.send("Network.enable");
    await connection.send("Runtime.enable");
    await connection.send("Log.enable");
    connections.set(target.id, connection);
    seenTargets.add(target.id);
    write("target.attached", { kind, targetId: target.id, title: target.title, url: target.url });
    if (kind === "codex") {
      const status = await connection.send("Runtime.evaluate", {
        expression: `(() => { const x=window.__codexTaskboardInjection__; const p=document.getElementById('codex-taskboard-page'); const f=document.getElementById('codex-taskboard-frame'); return {entryMounted:Boolean(document.getElementById('codex-taskboard-entry')),pageMounted:Boolean(p),pageVisible:p?.hidden===false,frameReady:x?.ready===true,frameSrc:f?.src||null,managedUrl:window.__CODEX_TASKBOARD_URL__||null,sourceHash:x?.sourceHash||null}; })()`,
        returnByValue: true,
      });
      write("codex.injection-status", { targetId: target.id, status: status?.result?.value ?? null });
    }
  } catch (error) {
    connection.close();
    write("target.attach-failed", { kind, targetId: target.id, error: error.message });
  }
}

async function scan() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${options.port}/json/list`)).json();
  } catch (error) {
    write("cdp.scan-failed", { port: options.port, error: error.message });
    return;
  }
  const activeIds = new Set();
  for (const target of targets) {
    if (!targetKind(target)) continue;
    activeIds.add(target.id);
    await inspectTarget(target);
  }
  for (const [id, connection] of connections) {
    if (activeIds.has(id)) continue;
    connection.close();
    connections.delete(id);
    write("target.detached", { targetId: id });
  }
}

write("observer.started", { port: options.port, logFile: options.logFile, projectRoot });
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
while (!stopping) {
  await scan();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
for (const connection of connections.values()) connection.close();
write("observer.stopped", { attachedTargets: seenTargets.size });
await new Promise((resolve) => file.end(resolve));
