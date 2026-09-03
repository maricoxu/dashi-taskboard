import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installerSource = await readFile(
  new URL("../scripts/install-source-launcher.mjs", import.meta.url),
  "utf8",
);

test("source LaunchAgent keeps the injector alive with launchd backoff", () => {
  assert.match(installerSource, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(installerSource, /<key>KeepAlive<\/key><true\/>/);
  assert.match(installerSource, /<key>ThrottleInterval<\/key><integer>5<\/integer>/);
  assert.ok(installerSource.includes('while /bin/kill -0 "$pid" 2>/dev/null'));
  assert.ok(installerSource.includes('done\n      exit 1'));
  assert.ok(installerSource.includes('if [[') && installerSource.includes('--foreground'));
  assert.match(installerSource, /<string>--service-only<\/string>/);
  assert.match(installerSource, /--source-log --service-only --watch --open --port 9231/);
});
