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
  assert.ok(panelSource.includes("tabId: state.currentTab?.id"));
  assert.ok(panelSource.includes("profileId: saved.id"));
  assert.ok(panelSource.includes("expectedRevision: state.revision"));
  assert.doesNotMatch(panelSource, /runtime\.requestManualRun[\s\S]{0,260}payload:\s*\{[\s\S]{0,100}profile:\s*/);
});

test("worker owns snapshot broadcast, leases, and session-only diagnostics", () => {
  assert.match(workerSource, /chrome.storage.local.setAccessLevel/);
  assert.ok(workerSource.includes("chrome.storage.session.get(key)"));
  assert.ok(workerSource.includes("chrome.storage.session.get(LOG_KEY)"));
  assert.match(workerSource, /GRANT_KEY_PREFIX/);
  assert.match(workerSource, /case "log.clear": return clearRuntimeLogs()/);
});

test("refresh is a terminal runtime action with loop protection", () => {
  assert.match(contentSource, /REFRESH_GUARD_TTL_MS = 30000/);
  assert.match(contentSource, /navigationRequested: true/);
  assert.match(contentSource, /window\.location\.reload\(\)/);
  assert.match(panelSource, /refresh: "刷新页面"/);
  assert.match(panelSource, /刷新页面必须是最后一个启用步骤/);
});
