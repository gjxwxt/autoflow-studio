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
