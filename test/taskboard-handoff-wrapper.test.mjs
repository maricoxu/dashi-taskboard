import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(projectRoot, "scripts", "taskboard-handoff.mjs");

test("taskboard handoff wrapper exposes the short command workflow", () => {
  const result = spawnSync(process.execPath, [wrapper, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /npm run taskboard:handoff -- <status\\|store\\|receive>/);
  assert.match(result.stdout, /TASKBOARD_HANDOFF_SCRIPT/);
});

test("taskboard handoff wrapper reports a missing core script clearly", () => {
  const result = spawnSync(process.execPath, [wrapper, "status"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TASKBOARD_HANDOFF_SCRIPT: path.join(projectRoot, "missing-taskboard-handoff.py"),
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /找不到 Taskboard Handoff 核心脚本/);
});
