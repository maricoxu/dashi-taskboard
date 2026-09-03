#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
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
const maxLogStringLength = 4_096;
const maxLogLineLength = 32_768;
const rendererMemoryLogIntervalMs = 10_000;
const rendererHighMemoryThresholdKb = 512 * 1024;
const systemDiagnosticDirectory = "/Library/Logs/DiagnosticReports";
const defaultObserverDurationMs = 30 * 60 * 1_000;

function parseArgs(argv) {
  const options = {
    port: 9232,
    logFile: defaultLogFile,
    durationMs: defaultObserverDurationMs,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--log-file") options.logFile = path.resolve(argv[++index]);
    else if (arg === "--duration-minutes") {
      options.durationMs = Number(argv[++index]) * 60 * 1_000;
    }
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
    throw new Error("--duration-minutes must be a non-negative number");
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
      /data:[^,\s"']*(?:;base64)?,[^"'\s]*/gi,
      "data:<redacted>",
    )
    .replace(
      /(https?:\/\/127\.0\.0\.1:\d+)\/[a-f0-9-]{16,128}(?=\/|\?|["'\s]|$)/gi,
      "$1/<redacted>",
    )
    .replace(
      /(CODEX_TASKBOARD_INSTANCE_(?:TOKEN|SECRET)\s*[=:]\s*)[^\s"']+/gi,
      "$1<redacted>",
    );
}

function boundedText(value, limit = maxLogStringLength) {
  const text = redact(String(value));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...<truncated ${text.length - limit} chars>`;
}

function normalizeForLog(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value);
  if (depth >= 5) return "[depth omitted]";
  if (Array.isArray(value)) {
    const values = value.slice(0, 32).map((item) => normalizeForLog(item, depth + 1));
    if (value.length > values.length) values.push(`[${value.length - values.length} items omitted]`);
    return values;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 64);
    const result = Object.fromEntries(
      entries.map(([key, item]) => [boundedText(key, 256), normalizeForLog(item, depth + 1)]),
    );
    if (Object.keys(value).length > entries.length) result.__omittedKeys = true;
    return result;
  }
  return boundedText(value);
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
    this.requestMetadata = new Map();
    this.closed = false;
    this.onClosed = null;
    this.onSocketError = null;
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
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        this.onSocketError?.({ message: `Invalid CDP message: ${error.message}` });
        return;
      }
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
    this.socket.addEventListener("error", (event) => {
      this.onSocketError?.({
        message: event?.error?.message || event?.message || "CDP WebSocket error",
      });
    });
    this.socket.addEventListener("close", (event) => {
      const intentional = this.closed;
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP WebSocket closed"));
      this.pending.clear();
      this.onClosed?.({
        code: event?.code ?? null,
        reason: event?.reason || "",
        wasClean: event?.wasClean ?? null,
        intentional,
      });
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
  let serialized;
  try {
    serialized = JSON.stringify(normalizeForLog(detail));
  } catch (error) {
    serialized = JSON.stringify({ serializationError: error.message });
  }
  const line = `[${timestamp()} pid=${process.pid} uptimeMs=${Math.round(process.uptime() * 1000)}] ${kind} ${boundedText(serialized, maxLogLineLength)}`;
  console.log(line);
  file.write(`${line}\n`);
}

const connections = new Map();
const seenTargets = new Set();
const rendererProcesses = new Map();
const crashpadFiles = new Map();
const crashpadDirectories = new Set();
const initializedCrashpadDirectories = new Set();
const systemDiagnosticFiles = new Set();
let rendererSnapshotInitialized = false;
let crashpadSnapshotInitialized = false;
let systemDiagnosticSnapshotInitialized = false;
let lastRendererMemoryLogAt = 0;
let lastSystemDiagnosticScanAt = 0;
let rendererProcessScanFailureLogged = false;
let crashpadScanFailureLogged = false;
let systemDiagnosticScanFailureLogged = false;
let cdpScanFailureLogged = false;
let stopping = false;

function profileFromRendererCommand(command) {
  return command.match(/(?:^|\s)--user-data-dir=(.*?)(?=\s--|$)/)?.[1] || null;
}

function rendererProcessSummary(processInfo) {
  return {
    pid: processInfo.pid,
    ppid: processInfo.ppid,
    rssKb: processInfo.rssKb,
    cpuPercent: processInfo.cpuPercent,
    elapsed: processInfo.elapsed,
    profile: processInfo.profile,
    command: boundedText(processInfo.command, 512),
  };
}

function readRendererProcesses() {
  const result = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,rss=,%cpu=,etime=,command="],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "ps exited unsuccessfully");
  const processes = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!match || !match[6].includes("Codex (Renderer)")) continue;
    const command = match[6];
    const profile = profileFromRendererCommand(command);
    if (profile) crashpadDirectories.add(path.join(profile, "Crashpad", "pending"));
    processes.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuPercent: Number(match[4]),
      elapsed: match[5],
      profile,
      command,
    });
  }
  return processes;
}

async function scanRendererProcesses() {
  let current;
  try {
    current = readRendererProcesses();
    rendererProcessScanFailureLogged = false;
  } catch (error) {
    if (!rendererProcessScanFailureLogged) {
      write("renderer.process-scan-failed", { error: error.message });
      rendererProcessScanFailureLogged = true;
    }
    return;
  }
  if (!rendererSnapshotInitialized) {
    write("renderer.snapshot", {
      count: current.size,
      processes: [...current.values()].map(rendererProcessSummary),
    });
    rendererSnapshotInitialized = true;
  } else {
    for (const [pid, processInfo] of current) {
      if (!rendererProcesses.has(pid)) write("renderer.started", rendererProcessSummary(processInfo));
    }
    for (const [pid, processInfo] of rendererProcesses) {
      if (!current.has(pid)) write("renderer.exited", { ...rendererProcessSummary(processInfo), observedAt: timestamp() });
    }
  }
  const now = Date.now();
  if (now - lastRendererMemoryLogAt >= rendererMemoryLogIntervalMs) {
    const highMemory = [...current.values()]
      .filter((processInfo) => processInfo.rssKb >= rendererHighMemoryThresholdKb)
      .map(rendererProcessSummary);
    write("renderer.memory-snapshot", {
      count: current.size,
      totalRssKb: [...current.values()].reduce((total, processInfo) => total + processInfo.rssKb, 0),
      highMemory,
    });
    lastRendererMemoryLogAt = now;
  }
  rendererProcesses.clear();
  for (const [pid, processInfo] of current) rendererProcesses.set(pid, processInfo);
}

async function readCrashpadMetadata(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    const parsed = JSON.parse(source.slice(0, 64 * 1024));
    return {
      captureKind: parsed.capture_kind || null,
      processType: parsed.ptype || null,
      version: parsed.ver || null,
      osArch: parsed.osarch || null,
      guid: parsed.guid || null,
    };
  } catch (error) {
    return { metadataError: error.message };
  }
}

async function scanCrashpad() {
  if (process.platform !== "darwin") return;
  const discovered = new Set();
  try {
    for (const directory of crashpadDirectories) {
      const firstScanForDirectory = !initializedCrashpadDirectories.has(directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(directory, entry.name);
        const fileStat = await stat(filePath);
        discovered.add(filePath);
        const previous = crashpadFiles.get(filePath);
        const changed = !previous
          || previous.mtimeMs !== fileStat.mtimeMs
          || previous.size !== fileStat.size;
        crashpadFiles.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size });
        if (!changed || !crashpadSnapshotInitialized || firstScanForDirectory) continue;
        write("crashpad.new", {
          file: filePath,
          profile: path.dirname(path.dirname(path.dirname(filePath))),
          mtime: new Date(fileStat.mtimeMs).toISOString(),
          size: fileStat.size,
          ...(await readCrashpadMetadata(filePath)),
        });
      }
      initializedCrashpadDirectories.add(directory);
    }
    for (const filePath of crashpadFiles.keys()) {
      if (!discovered.has(filePath)) crashpadFiles.delete(filePath);
    }
    if (!crashpadSnapshotInitialized) {
      write("crashpad.snapshot", {
        directories: [...crashpadDirectories],
        pendingCount: crashpadFiles.size,
      });
      crashpadSnapshotInitialized = true;
    }
    crashpadScanFailureLogged = false;
  } catch (error) {
    if (!crashpadScanFailureLogged) {
      write("crashpad.scan-failed", { error: error.message });
      crashpadScanFailureLogged = true;
    }
  }
}

async function scanSystemDiagnostics() {
  if (process.platform !== "darwin" || Date.now() - lastSystemDiagnosticScanAt < rendererMemoryLogIntervalMs) return;
  lastSystemDiagnosticScanAt = Date.now();
  try {
    const entries = await readdir(systemDiagnosticDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^JetsamEvent-.*\.ips$/i.test(entry.name))
      .map((entry) => path.join(systemDiagnosticDirectory, entry.name));
    if (!systemDiagnosticSnapshotInitialized) {
      files.forEach((filePath) => systemDiagnosticFiles.add(filePath));
      write("system.diagnostics-snapshot", { jetsamCount: files.length });
      systemDiagnosticSnapshotInitialized = true;
      return;
    }
    for (const filePath of files) {
      if (systemDiagnosticFiles.has(filePath)) continue;
      systemDiagnosticFiles.add(filePath);
      let source = "";
      try { source = (await readFile(filePath, "utf8")).slice(0, 256 * 1024); } catch {}
      write("system.jetsam", {
        file: filePath,
        largestProcess: source.match(/"largestProcess"\s*:\s*"([^"]+)"/)?.[1] || null,
        processNames: [...source.matchAll(/"name"\s*:\s*"([^"]*Codex[^"]*)"/gi)]
          .slice(0, 8)
          .map((match) => match[1]),
      });
    }
    systemDiagnosticScanFailureLogged = false;
  } catch (error) {
    if (!systemDiagnosticScanFailureLogged) {
      write("system.diagnostics-scan-failed", { directory: systemDiagnosticDirectory, error: error.message });
      systemDiagnosticScanFailureLogged = true;
    }
  }
}

async function inspectTarget(target) {
  const kind = targetKind(target);
  if (!kind || !target.webSocketDebuggerUrl || connections.has(target.id)) return;
  const connection = new Connection(target);
  connection.onSocketError = (detail) => write("cdp.socket-error", {
    kind,
    targetId: target.id,
    ...detail,
  });
  connection.onClosed = (detail) => write("cdp.closed", {
    kind,
    targetId: target.id,
    ...detail,
  });
  try {
    await connection.open();
    connection.onEvent = (message) => {
      if (message.method === "Network.requestWillBeSent") {
        const requestId = message.params?.requestId;
        if (requestId) {
          connection.requestMetadata.set(requestId, {
            url: message.params.request?.url || null,
            method: message.params.request?.method || null,
            resourceType: message.params.type || null,
          });
          while (connection.requestMetadata.size > 4_096) {
            const [oldestRequestId] = connection.requestMetadata.keys();
            connection.requestMetadata.delete(oldestRequestId);
          }
        }
      } else if (message.method === "Network.responseReceived") {
        const response = message.params.response;
        const url = response?.url || "";
        if (url.includes("/api/") || url.includes("/events")) {
          write("network.response", {
            kind,
            targetId: target.id,
            status: response.status,
            mimeType: response.mimeType,
            method: connection.requestMetadata.get(message.params.requestId)?.method || null,
            url,
          });
        }
      } else if (message.method === "Inspector.targetCrashed") {
        write("inspector.target-crashed", {
          kind,
          targetId: target.id,
          status: message.params?.status || null,
          errorCode: message.params?.errorCode ?? null,
        });
      } else if (message.method === "Inspector.targetReloadedAfterCrash") {
        write("inspector.target-reloaded-after-crash", { kind, targetId: target.id });
      } else if (message.method === "Page.lifecycleEvent" && message.params?.name === "crashed") {
        write("page.lifecycle-crashed", {
          kind,
          targetId: target.id,
          frameId: message.params?.frameId || null,
          loaderId: message.params?.loaderId || null,
        });
      } else if (message.method === "Network.loadingFailed") {
        const request = connection.requestMetadata.get(message.params.requestId) || {};
        connection.requestMetadata.delete(message.params.requestId);
        if (message.params.canceled && message.params.errorText === "net::ERR_ABORTED") return;
        write("network.failed", {
          kind,
          targetId: target.id,
          errorText: message.params.errorText,
          canceled: message.params.canceled ?? false,
          requestId: message.params.requestId,
          url: request.url || null,
          method: request.method || null,
          resourceType: request.resourceType || null,
        });
      } else if (message.method === "Network.loadingFinished") {
        connection.requestMetadata.delete(message.params.requestId);
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails || {};
        write("runtime.exception", {
          kind,
          targetId: target.id,
          text: details.text || "",
          description: details.exception?.description || "",
          url: details.url || null,
          lineNumber: details.lineNumber ?? null,
          columnNumber: details.columnNumber ?? null,
          stackTrace: details.stackTrace?.callFrames?.slice(0, 8).map((frame) => ({
            functionName: frame.functionName,
            url: frame.url,
            lineNumber: frame.lineNumber,
            columnNumber: frame.columnNumber,
          })) || [],
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
    try { await connection.send("Page.enable"); } catch (error) {
      write("cdp.domain-enable-failed", { kind, targetId: target.id, domain: "Page", error: error.message });
    }
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
    if (!cdpScanFailureLogged) {
      write("cdp.scan-failed", { port: options.port, error: error.message });
      cdpScanFailureLogged = true;
    }
    return;
  }
  if (cdpScanFailureLogged) {
    write("cdp.scan-recovered", { port: options.port });
    cdpScanFailureLogged = false;
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

const observerDeadline = options.durationMs === 0
  ? Number.POSITIVE_INFINITY
  : Date.now() + options.durationMs;
write("observer.started", {
  port: options.port,
  logFile: options.logFile,
  projectRoot,
  durationMs: options.durationMs,
});
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
while (!stopping && Date.now() < observerDeadline) {
  await scanRendererProcesses();
  await scanCrashpad();
  await scanSystemDiagnostics();
  await scan();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
for (const connection of connections.values()) connection.close();
write("observer.stopped", {
  attachedTargets: seenTargets.size,
  reason: stopping ? "signal" : "duration",
});
await new Promise((resolve) => file.end(resolve));
