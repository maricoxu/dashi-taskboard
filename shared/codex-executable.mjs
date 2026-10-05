import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function executableOnPath(env, platform) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    if (platform === "win32") {
      const nativeExecutable = executableFile(path.join(directory, "codex.exe"));
      if (nativeExecutable) return nativeExecutable;

      const npmEntry = executableFile(path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ));
      if (npmEntry) return npmEntry;
      continue;
    }

    const executable = executableFile(path.join(directory, "codex"));
    if (executable) return executable;
  }
  return null;
}

function codexExecutableCandidatesInApp(appPath, platform = process.platform) {
  if (platform === "win32") {
    return [path.win32.join(path.win32.dirname(appPath), "resources", "codex.exe")];
  }
  if (platform === "linux") return ["/usr/lib/chatgpt/resources/codex"];
  const resources = path.join(appPath, "Contents", "Resources");
  return [
    path.join(resources, "codex"),
    path.join(resources, "codex-cli", "bin", "codex"),
    path.join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
  ];
}

export function codexExecutableInApp(appPath, platform = process.platform) {
  return codexExecutableCandidatesInApp(appPath, platform)[0];
}

export function resolveCodexExecutable({
  explicit,
  appPath,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const configured = env.CODEX_EXECUTABLE ?? env.CODEX_CLI_PATH;
  if (typeof configured === "string" && configured.trim()) return configured.trim();

  if (appPath) {
    for (const candidate of codexExecutableCandidatesInApp(appPath, platform)) {
      const bundled = executableFile(candidate);
      if (bundled) return bundled;
    }
  }

  const installedCli = executableOnPath(env, platform);
  if (installedCli) return installedCli;

  if (platform === "darwin") {
    for (const applicationDirectory of ["/Applications", path.join(homeDirectory, "Applications")]) {
    for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
        for (const candidate of codexExecutableCandidatesInApp(
          path.join(applicationDirectory, applicationName),
          platform,
        )) {
          const bundled = executableFile(candidate);
          if (bundled) return bundled;
        }
      }
    }
  }

  return "codex";
}
