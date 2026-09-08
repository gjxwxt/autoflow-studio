import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [contentSource, panelSource, workerSource] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/panel.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8")
]);

test("content runtime has no direct storage.local access", () => {
  assert.doesNotMatch(contentSource, /chrome.storage.local/);
  assert.match(contentSource, /type: "runtime.getSnapshot"/);
  assert.match(contentSource, /type: "runtime.getStepValue"/);
});

test("manual run sends an identity, not a complete profile", () => {
  assert.match(panelSource, /type: "runtime.requestManualRun"/);
  assert.match(panelSource, /payload: { profileId: saved.id, expectedRevision: state.revision }/);
  assert.doesNotMatch(panelSource, /runtime.requestManualRun[sS]{0,260}payload:s*{[sS]{0,100}profile:s*/);
});

test("worker owns snapshot broadcast, leases, and session-only diagnostics", () => {
  assert.match(workerSource, /chrome.storage.local.setAccessLevel/);
  assert.ok(workerSource.includes("chrome.storage.session.get(LEASE_KEY)"));
  assert.ok(workerSource.includes("chrome.storage.session.get(LOG_KEY)"));
  assert.match(workerSource, /case "log.clear": return clearRuntimeLogs()/);
});
