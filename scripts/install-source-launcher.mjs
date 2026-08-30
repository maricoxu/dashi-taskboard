#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const appPath = path.resolve(
  process.env.CODEX_TASKBOARD_SOURCE_APP
    || "/Applications/Codex Taskboard Source.app",
);
const appExecutable = path.join(
  appPath,
  "Contents",
  "MacOS",
  "codex-taskboard-source",
);
const launchAgentLabel = "com.xuyehua.codex-taskboard-source";
const launchAgentPath = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${launchAgentLabel}.plist`,
);
const logDirectory = path.join(os.homedir(), "Library", "Logs", "Codex Taskboard");
const bootstrapLog = path.join(logDirectory, "source-launcher-bootstrap.log");

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function nodeVersionSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

if (process.platform !== "darwin") {
  throw new Error("The source launcher installer currently supports macOS only");
}
if (!nodeVersionSupported()) {
  throw new Error(`Node.js 22.5 or newer is required; current version is ${process.version}`);
}
if (path.basename(appPath) !== "Codex Taskboard Source.app") {
  throw new Error("CODEX_TASKBOARD_SOURCE_APP must end with Codex Taskboard Source.app");
}

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Codex Taskboard Source</string>
  <key>CFBundleExecutable</key><string>codex-taskboard-source</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>${launchAgentLabel}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Codex Taskboard Source</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(packageJson.version)}</string>
  <key>CFBundleVersion</key><string>${xml(packageJson.version)}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

const launcherScript = `#!/bin/zsh
set -u

CONTENTS_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/Codex Taskboard"
BOOTSTRAP_LOG="$LOG_DIR/source-launcher-bootstrap.log"
mkdir -p "$LOG_DIR"

log_error() {
  print -r -- "[$(/bin/date '+%Y-%m-%dT%H:%M:%S%z')] $1" >> "$BOOTSTRAP_LOG"
}

SOURCE_ROOT="\${CODEX_TASKBOARD_SOURCE_ROOT:-}"
if [[ -z "$SOURCE_ROOT" && -f "$CONTENTS_DIR/Resources/source-root" ]]; then
  SOURCE_ROOT="$(/usr/bin/sed -n '1p' "$CONTENTS_DIR/Resources/source-root")"
fi
if [[ -z "$SOURCE_ROOT" && -f "$HOME/Code/dashi-taskboard/scripts/codex-injector.mjs" ]]; then
  SOURCE_ROOT="$HOME/Code/dashi-taskboard"
fi
if [[ ! -f "$SOURCE_ROOT/scripts/codex-injector.mjs" ]]; then
  log_error "Source root is invalid: $SOURCE_ROOT"
  exit 1
fi

NODE_BIN="\${CODEX_TASKBOARD_NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [[ ! -x "$NODE_BIN" ]]; then
  log_error "Node.js 22.5 or newer was not found"
  exit 1
fi

while read -r pid command; do
  if [[ "$command" != *"scripts/codex-injector.mjs"* || "$command" != *"--watch"* ]]; then
    continue
  fi
  process_cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')"
  if [[ "$process_cwd" == "$SOURCE_ROOT" ]]; then
    /bin/kill -USR2 "$pid" 2>/dev/null || true
    exit 0
  fi
done < <(/bin/ps -axo pid=,command=)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CODEX_TASKBOARD_HOST=127.0.0.1
export CODEX_TASKBOARD_DATA_DIR="$SOURCE_ROOT/.data"
export CODEX_TASKBOARD_RUNTIME_FILE="$SOURCE_ROOT/.data/launcher-runtime.json"
export CODEX_TASKBOARD_LOG_FILE="$LOG_DIR/codex-taskboard-source.log"
export CODEX_TASKBOARD_CODEX_SOURCE_PROFILE="$HOME/Library/Application Support/Codex"
export CODEX_TASKBOARD_CODEX_PROFILE="$HOME/Library/Application Support/Codex Taskboard Source/Codex Profile"

cd "$SOURCE_ROOT"
if [[ "\${1:-}" == "--foreground" ]]; then
  exec "$NODE_BIN" "$SOURCE_ROOT/scripts/codex-injector.mjs" \
    --source-log --launch --watch --open --port 9231
fi

/usr/bin/nohup "$NODE_BIN" "$SOURCE_ROOT/scripts/codex-injector.mjs" \
  --source-log --launch --watch --open --port 9231 \
  >> "$BOOTSTRAP_LOG" 2>&1 &
exit 0
`;

const launchAgentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(appExecutable)}</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(bootstrapLog)}</string>
  <key>StandardErrorPath</key><string>${xml(bootstrapLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;

await rm(appPath, { recursive: true, force: true });
await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
await mkdir(path.join(appPath, "Contents", "Resources"), { recursive: true });
await mkdir(path.dirname(launchAgentPath), { recursive: true });
await mkdir(logDirectory, { recursive: true, mode: 0o700 });

await Promise.all([
  writeFile(path.join(appPath, "Contents", "Info.plist"), infoPlist, { mode: 0o644 }),
  writeFile(appExecutable, launcherScript, { mode: 0o755 }),
  writeFile(
    path.join(appPath, "Contents", "Resources", "source-root"),
    `${projectRoot}\n`,
    { mode: 0o600 },
  ),
  copyFile(
    path.join(projectRoot, "src-tauri", "icons", "icon.icns"),
    path.join(appPath, "Contents", "Resources", "icon.icns"),
  ),
  writeFile(launchAgentPath, launchAgentPlist, { mode: 0o644 }),
]);
await chmod(appExecutable, 0o755);

await execFileAsync("/usr/bin/plutil", ["-lint", path.join(appPath, "Contents", "Info.plist")]);
await execFileAsync("/usr/bin/plutil", ["-lint", launchAgentPath]);
await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);

const domain = `gui/${process.getuid()}`;
try {
  await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${launchAgentLabel}`]);
} catch {}
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    await execFileAsync("/bin/launchctl", ["print", `${domain}/${launchAgentLabel}`]);
  } catch {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await execFileAsync("/bin/launchctl", ["bootstrap", domain, launchAgentPath]);
try {
  await chmod(bootstrapLog, 0o600);
} catch {}

console.log(JSON.stringify({
  appPath,
  sourceRoot: projectRoot,
  launchAgentPath,
  logFile: path.join(logDirectory, "codex-taskboard-source.log"),
  bootstrapLog,
}, null, 2));
