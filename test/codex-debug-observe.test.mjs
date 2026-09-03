import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(
  new URL("../scripts/codex-debug-observe.mjs", import.meta.url),
  "utf8",
);

test("renderer diagnostics classify crashes, process exits, and CDP disconnects", () => {
  assert.match(source, /Inspector\.targetCrashed/);
  assert.match(source, /Inspector\.targetReloadedAfterCrash/);
  assert.match(source, /inspector\.target-crashed/);
  assert.match(source, /renderer\.started/);
  assert.match(source, /renderer\.exited/);
  assert.match(source, /cdp\.closed/);
  assert.match(source, /cdp\.socket-error/);
  assert.match(source, /Network\.requestWillBeSent/);
  assert.match(source, /requestMetadata/);
});

test("diagnostic logs are bounded and collect Crashpad and Jetsam evidence", () => {
  assert.match(source, /maxLogStringLength = 4_096/);
  assert.match(source, /maxLogLineLength = 32_768/);
  assert.match(source, /data:<redacted>/);
  assert.match(source, /crashpad\.new/);
  assert.match(source, /initializedCrashpadDirectories/);
  assert.match(source, /system\.jetsam/);
  assert.match(source, /renderer\.memory-snapshot/);
  assert.match(source, /cdp\.scan-recovered/);
});

test("renderer diagnostics stop after thirty minutes unless explicitly unbounded", () => {
  assert.match(source, /defaultObserverDurationMs = 30 \* 60 \* 1_000/);
  assert.match(source, /--duration-minutes/);
  assert.match(source, /options\.durationMs === 0/);
  assert.match(source, /Date\.now\(\) < observerDeadline/);
  assert.match(source, /reason: stopping \? "signal" : "duration"/);
});
