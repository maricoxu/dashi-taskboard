import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const hostSource = await readFile(new URL("../web/src/embeddedHost.mjs", import.meta.url), "utf8");

test("embedded host context updates are deduplicated before React state changes", () => {
  assert.match(source, /function hostContextSignature\(context: HostContext\)/);
  assert.match(source, /const hostContextSignatureRef = useRef\(""\)/);
  assert.match(source, /const signature = hostContextSignature\(payload\)/);
  assert.match(source, /if \(signature === hostContextSignatureRef\.current\) return/);
  assert.match(source, /hostContextSignatureRef\.current = signature/);
});

test("embedded host HTTP requests can be aborted instead of lingering for the full timeout", () => {
  assert.match(hostSource, /init\.signal\?\.addEventListener\("abort"/);
  assert.match(hostSource, /init\.signal\?\.removeEventListener\("abort"/);
  assert.match(hostSource, /signal: init\.signal/);
});
