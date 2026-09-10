import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/shared.js", import.meta.url), "utf8");
const sandbox = { URL, globalThis: {} };
vm.runInNewContext(source, sandbox, { filename: "extension/shared.js" });
const shared = sandbox.globalThis.AutoFillShared;

const baseProfile = (overrides = {}) => ({
  id: "profile-1",
  name: "测试规则",
  enabled: true,
  site: { origin: "https://example.com", pathPrefix: "/login", hashPrefix: "" },
  steps: [{
    id: "step-1",
    label: "密码",
    action: "fill",
    secret: true,
    value: "virtual-password",
    target: { tag: "input", type: "password", id: "password", text: "virtual-password" }
  }],
  ...overrides
});

test("share export is a whitelist and never carries input values", () => {
  const profile = baseProfile({
    steps: [
      baseProfile().steps[0],
      {
        id: "step-2",
        label: "登录",
        action: "click",
        value: "",
        target: { tag: "button", text: "登录", css: "button[type=submit]" }
      },
      {
        id: "step-3",
        label: "同意条款",
        action: "check",
        value: true,
        target: { tag: "input", type: "checkbox", id: "agree" }
      }
    ]
  });

  const share = shared.exportProfileData(profile, false);
  assert.equal("value" in share.steps[0], false);
  assert.equal(share.steps[0].target.text, undefined);
  assert.equal(share.steps[1].target.text, "登录");
  assert.equal(share.steps[2].actionValue, true);
  assert.equal(shared.normalizeProfile(share).steps[2].value, true);
  assert.equal("runState" in share, false);

  const backup = shared.exportProfileData(profile, true);
  assert.equal(backup.steps[0].value, "virtual-password");
  assert.equal(backup.steps[0].target.text, undefined);

  const redacted = shared.redactProfileValues(profile);
  assert.equal(redacted.steps[0].value, "");
  assert.equal(redacted.steps[1].value, "");
  assert.equal(redacted.steps[2].value, true);
});

test("legacy trigger migration keeps its submit step", () => {
  const migrated = shared.normalizeProfile({
    id: "legacy",
    site: { origin: "https://example.com", pathPrefix: "/portal/", hashPrefix: "" },
    fields: [{ id: "username", label: "用户名", value: "virtual-user", target: { tag: "input", name: "username" } }],
    trigger: { enabled: true, target: { tag: "button", text: "登录", css: "button.submit" } }
  });

  assert.equal(migrated.steps.length, 2);
  assert.equal(migrated.steps[1].action, "click");
  assert.equal(migrated.steps[1].target.text, "登录");
});

test("explicit zero cooldown remains zero", () => {
  const normalized = shared.normalizeProfile(baseProfile({
    trigger: { type: "elementVisible", target: { tag: "div", id: "ready" }, options: { cooldownMs: 0, timeoutMs: 0 } }
  }));

  assert.equal(normalized.trigger.options.cooldownMs, 0);
  assert.equal(normalized.trigger.options.timeoutMs, 1000);
});

test("unknown actions and future schema versions cannot be activated", () => {
  const unknownAction = shared.normalizeProfile(baseProfile({
    steps: [{ id: "step-1", label: "未知", action: "executeScript", value: "alert(1)", target: {} }]
  }));
  assert.equal(unknownAction.steps[0].enabled, false);
  assert.equal(shared.isSupportedProfile(unknownAction), false);

  const future = shared.normalizeProfile(baseProfile({ schemaVersion: 99 }));
  assert.equal(future.unsupportedSchemaVersion, 99);
  assert.equal(shared.isSupportedProfile(future), false);
});

test("target normalization strips unrecognized fields", () => {
  const normalized = shared.normalizeProfile(baseProfile({
    steps: [{ id: "step-1", label: "字段", action: "fill", target: { tag: "input", value: "secret", secretToken: "x" } }]
  }));
  assert.equal(normalized.steps[0].target.value, undefined);
  assert.equal(normalized.steps[0].target.secretToken, undefined);
});

test("runtime snapshots strip value-bearing fields before reaching content scripts", () => {
  const snapshot = shared.runtimeProfile(baseProfile({
    steps: [
      baseProfile().steps[0],
      { id: "step-2", label: "下拉框", action: "select", value: "private-option", target: { tag: "select", id: "team" } },
      { id: "step-3", label: "勾选", action: "check", value: true, target: { tag: "input", type: "checkbox", id: "agree" } }
    ]
  }));

  assert.equal(snapshot.steps[0].value, "");
  assert.equal(snapshot.steps[0].valueRequired, true);
  assert.equal(snapshot.steps[1].value, "");
  assert.equal(snapshot.steps[1].valueRequired, true);
  assert.equal(snapshot.steps[2].value, true);
});

test("runtime diagnostics are redacted and URL query/hash is removed", () => {
  const event = shared.sanitizeRuntimeEvent({
    timestamp: 123,
    event: "step.failed",
    page: "https://example.com/login?sid=private#hash",
    context: {
      action: "fill",
      value: "private-value",
      password: "private-password",
      selector: "#password",
      attempt: 2
    }
  });

  assert.equal(event.page, "https://example.com/login");
  assert.equal(event.context.action, "fill");
  assert.equal(event.context.attempt, 2);
  assert.equal("value" in event.context, false);
  assert.equal("password" in event.context, false);
  assert.equal("selector" in event.context, false);

  const reset = shared.sanitizeRuntimeEvent({
    event: "runtime.state.reset",
    context: { resetReason: "settingsChanged", canary: "CANARY_SECRET" }
  });
  assert.equal(reset.context.resetReason, "settingsChanged");
  assert.doesNotMatch(JSON.stringify(reset), /CANARY_SECRET/);
});

test("value-bearing action classification is explicit", () => {
  assert.equal(shared.isValueBearingAction("fill"), true);
  assert.equal(shared.isValueBearingAction("select"), true);
  assert.equal(shared.isValueBearingAction("click"), false);
  assert.equal(shared.isValueBearingAction("check"), false);
  assert.equal(shared.isValueBearingAction("refresh"), false);
});

test("refresh is a supported terminal action without a target value", () => {
  const profile = shared.normalizeProfile(baseProfile({
    steps: [{ id: "step-refresh", label: "刷新页面", action: "refresh", value: "ignored", target: { id: "stale" } }]
  }));
  assert.equal(shared.isSupportedProfile(profile), true);
  assert.equal(profile.steps[0].action, "refresh");
  assert.equal(profile.steps[0].value, "");
  assert.deepEqual(Object.keys(profile.steps[0].target), []);
  assert.equal(shared.runtimeProfile(profile).steps[0].value, "");

  const event = shared.sanitizeRuntimeEvent({
    event: "run.navigation_requested",
    context: { action: "refresh", phase: "navigation" }
  });
  assert.equal(event.event, "run.navigation_requested");
  assert.equal(event.context.action, "refresh");
  assert.equal(event.context.phase, "navigation");
});

test("runtime snapshot is an allowlisted DTO", () => {
  const profile = baseProfile({ futureField: "do-not-send" });
  profile.site.extra = "do-not-send";
  profile.trigger = { ...shared.normalizeProfile(profile).trigger, extra: "do-not-send" };
  profile.steps[0].futureField = "do-not-send";

  const snapshot = shared.runtimeProfile(profile);
  assert.equal(snapshot.futureField, undefined);
  assert.equal(snapshot.site.extra, undefined);
  assert.equal(snapshot.trigger.extra, undefined);
  assert.equal(snapshot.steps[0].futureField, undefined);
  assert.deepEqual(Object.keys(snapshot).sort(), ["enabled", "id", "name", "schemaVersion", "site", "steps", "trigger"]);
});

test("runtime diagnostics use allowlisted context and reject canary text", () => {
  const event = shared.sanitizeRuntimeEvent({
    event: "step.failed",
    context: {
      action: "fill",
      reason: "CANARY_SECRET",
      triggerType: "elementVisible",
      matches: 2,
      profileCount: 1,
      attempt: 1,
      revision: 3,
      canary: "CANARY_SECRET"
    }
  });

  assert.equal(event.context.action, "fill");
  assert.equal(event.context.triggerType, "elementVisible");
  assert.equal(event.context.matches, 2);
  assert.equal(event.context.reason, undefined);
  assert.equal(event.context.canary, undefined);
  assert.doesNotMatch(JSON.stringify(event), /CANARY_SECRET/);
});
