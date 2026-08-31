#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSyncRoot = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "Codex-Taskboard-Handoff",
);
const defaultHandoffScript = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "yehua的笔记",
  "6-System系统",
  "Scripts脚本",
  "taskboard_handoff.py",
);
const aliases = new Map([
  ["check", "status"],
  ["publish", "store"],
  ["pull", "receive"],
  ["restore", "receive"],
]);

function usage() {
  process.stdout.write(
    [
      "用法：npm run taskboard:handoff -- <status|store|receive> [选项]",
      "",
      "短命令：",
      "  status                 查看本机数据库、iCloud HEAD 和 Handoff 基线",
      "  store                  发布当前仓库 .data 的 Taskboard 快照",
      "  receive                预览 iCloud 快照；应用时追加 --apply",
      "",
      "示例：",
      "  npm run taskboard:handoff -- status --json",
      "  npm run taskboard:handoff -- store",
      "  npm run taskboard:handoff -- receive --allow-bootstrap --apply",
      "",
      "可用环境变量：",
      "  TASKBOARD_HANDOFF_SCRIPT  覆盖 Handoff Python 核心脚本路径",
      "  TASKBOARD_HANDOFF_DATA_DIR 覆盖本机 Taskboard 数据目录",
      "  TASKBOARD_HANDOFF_SYNC_ROOT 覆盖 iCloud Handoff 根目录",
      "  TASKBOARD_HANDOFF_DEVICE_ID 指定 mac-studio 或 macbook",
      "  TASKBOARD_HANDOFF_PYTHON    覆盖 Python 可执行文件",
    ].join("\n") + "\n",
  );
}

function hasOption(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(name + "="));
}

function resolvePython() {
  if (process.env.TASKBOARD_HANDOFF_PYTHON) return process.env.TASKBOARD_HANDOFF_PYTHON;
  if (existsSync("/usr/bin/python3")) return "/usr/bin/python3";
  return "python3";
}

const [rawCommand, ...rest] = process.argv.slice(2);
if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
  usage();
  process.exit(rawCommand ? 0 : 2);
}

const command = aliases.get(rawCommand) || rawCommand;
if (!new Set(["status", "store", "receive"]).has(command)) {
  process.stderr.write("未知 Handoff 命令：" + rawCommand + "\n\n");
  usage();
  process.exit(2);
}

const handoffScript = path.resolve(
  process.env.TASKBOARD_HANDOFF_SCRIPT || defaultHandoffScript,
);
if (!existsSync(handoffScript)) {
  process.stderr.write(
    [
      "找不到 Taskboard Handoff 核心脚本：" + handoffScript,
      "请确认 Obsidian 笔记库已经同步到本机，或设置 TASKBOARD_HANDOFF_SCRIPT 指向 taskboard_handoff.py。",
    ].join("\n") + "\n",
  );
  process.exit(2);
}

const forwarded = [command, ...rest];
if (!hasOption(rest, "--data-dir")) {
  forwarded.push(
    "--data-dir",
    process.env.TASKBOARD_HANDOFF_DATA_DIR || path.join(projectRoot, ".data"),
  );
}
if (!hasOption(rest, "--sync-root")) {
  forwarded.push(
    "--sync-root",
    process.env.TASKBOARD_HANDOFF_SYNC_ROOT || defaultSyncRoot,
  );
}

const result = spawnSync(resolvePython(), [handoffScript, ...forwarded], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write("无法启动 Handoff Python：" + result.error.message + "\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
