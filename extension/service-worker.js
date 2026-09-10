importScripts("shared.js");

const {
  DEFAULT_ATRUST_PROFILE,
  PROTOCOL_VERSION,
  copyProfile,
  createId,
  isSupportedProfile,
  isValueBearingAction,
  matchesProfile,
  normalizeOrigin,
  normalizeProfile,
  runtimeProfile,
  sanitizeRuntimeEvent
} = AutoFillShared;

const BASE_ORIGIN = "https://atrust.inforbus.com";
const DYNAMIC_PREFIX = "autofill-profile-";
const LOG_KEY = "runtimeLogs";
const LEASE_KEY_PREFIX = "runtimeLease:";
const GRANT_KEY_PREFIX = "manualGrant:";
const MAX_LOGS = 500;
const LEASE_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 30 * 1000;
let initializationPromise = null;
let writeChain = Promise.resolve();
let logWriteChain = Promise.resolve();
let grantWriteChain = Promise.resolve();

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function ensureStorageAccess() {
  if (typeof chrome.storage.local.setAccessLevel === "function") {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

async function ensureStorage() {
  const stored = await chrome.storage.local.get(["profiles", "globalEnabled", "enabled", "username", "password", "schemaVersion", "revision"]);
  if (Array.isArray(stored.profiles)) {
    const normalizedProfiles = stored.profiles.map(normalizeProfile);
    const updates = {
      schemaVersion: 3,
      profiles: normalizedProfiles,
      revision: Math.max(1, Number(stored.revision) || 0)
    };
    if (typeof stored.globalEnabled !== "boolean") updates.globalEnabled = true;
    await chrome.storage.local.set(updates);
    await chrome.storage.local.remove(["enabled", "username", "password"]);
    return;
  }

  // Fresh installs start empty. Keep the legacy migration only when the old
  // extension actually left configuration keys behind during an upgrade.
  const hasLegacyConfig = ["enabled", "username", "password"].some((key) => stored[key] !== undefined);
  const profiles = [];
  if (hasLegacyConfig) {
    const profile = copyProfile(DEFAULT_ATRUST_PROFILE);
    profile.enabled = Boolean(stored.enabled);
    profile.steps[0].value = stored.username || "";
    profile.steps[1].value = stored.password || "";
    profiles.push(profile);
  }
  await chrome.storage.local.set({
    schemaVersion: 3,
    profiles,
    activeProfileId: profiles[0]?.id || "",
    globalEnabled: typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : true,
    revision: 1
  });
  await chrome.storage.local.remove(["enabled", "username", "password"]);
}

async function readProfiles() {
  const stored = await chrome.storage.local.get({ profiles: [], globalEnabled: true, revision: 0 });
  const profiles = Array.isArray(stored.profiles)
    ? stored.profiles.map(normalizeProfile).filter(isSupportedProfile)
    : [];
  return {
    profiles,
    globalEnabled: stored.globalEnabled !== false,
    revision: Number(stored.revision) || 0
  };
}

async function validateRuntimeSender(sender) {
  if (sender?.id !== chrome.runtime.id || !sender?.tab?.id) {
    throw runtimeError("PROTOCOL_INVALID", "消息来源不是当前扩展页面");
  }
  if (sender.frameId !== 0) throw runtimeError("UNSUPPORTED_FRAME", "当前版本暂不支持 iframe 规则运行");
  if (!sender.documentId) throw runtimeError("PROTOCOL_INVALID", "缺少当前页面 documentId");
  // tabs.Tab.url preserves the SPA hash more reliably than MessageSender.url.
  const href = sender.tab.url || sender.url || "";
  if (!/^https?:/i.test(href)) throw runtimeError("URL_MISMATCH", "当前页面不是可配置的网站");
  return {
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
    href
  };
}

function validatePanelSender(sender) {
  const extensionPrefix = `chrome-extension://${chrome.runtime.id}/`;
  if (sender?.id !== chrome.runtime.id || !String(sender.url || "").startsWith(extensionPrefix)) {
    throw runtimeError("PROTOCOL_INVALID", "消息来源不是扩展面板");
  }
}

function validateContentSender(sender) {
  if (sender?.id !== chrome.runtime.id || !sender?.tab?.id || sender.frameId !== 0 || !sender.documentId) {
    throw runtimeError("PROTOCOL_INVALID", "日志来源不是当前页面运行时");
  }
}

async function broadcastSnapshotUpdated(revision) {
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => tab.id == null
    ? Promise.resolve()
    : chrome.tabs.sendMessage(tab.id, {
        protocolVersion: PROTOCOL_VERSION,
        type: "runtime.snapshotUpdated",
        payload: { revision }
      }, { frameId: 0 }).catch(() => undefined)));
}

function writeState(message, sendResponse) {
  writeChain = writeChain.then(async () => {
    await ensureInitialized();
    const expectedRevision = Number(message.expectedRevision);
    const stored = await chrome.storage.local.get("revision");
    const currentRevision = Number(stored.revision) || 0;
    if (Number.isFinite(expectedRevision) && expectedRevision !== currentRevision) {
      throw runtimeError("REVISION_STALE", "配置已被其他面板修改，请刷新后重试");
    }
    const nextState = message.state && typeof message.state === "object" ? message.state : {};
    const profiles = Array.isArray(nextState.profiles) ? nextState.profiles.map(normalizeProfile) : [];
    const revision = currentRevision + 1;
    await chrome.storage.local.set({
      schemaVersion: 3,
      profiles,
      activeProfileId: typeof nextState.activeProfileId === "string" ? nextState.activeProfileId : "",
      globalEnabled: nextState.globalEnabled !== false,
      revision
    });
    await syncContentScripts();
    return { ok: true, revision };
  }).then(sendResponse).catch((error) => sendResponse({
    ok: false,
    code: error.code || "CONFIG_WRITE_FAILED",
    message: error.message || "配置写入失败"
  }));
  return true;
}

function scriptIdForOrigin(origin) {
  return `${DYNAMIC_PREFIX}${origin.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 90)}`;
}

async function syncContentScripts() {
  if (!chrome.scripting?.getRegisteredContentScripts) return;
  const stored = await chrome.storage.local.get("profiles");
  const profiles = Array.isArray(stored.profiles) ? stored.profiles : [];
  const desired = new Map();

  for (const profile of profiles) {
    const rawOrigin = profile?.site?.origin;
    if (!rawOrigin) continue;
    try {
      const origin = normalizeOrigin(rawOrigin);
      if (origin === BASE_ORIGIN) continue;
      desired.set(scriptIdForOrigin(origin), {
        id: scriptIdForOrigin(origin),
        matches: [`${origin}/*`],
        js: ["shared.js", "content.js"],
        runAt: "document_start"
      });
    } catch {
      // Ignore incomplete profiles until the user fixes their site origin.
    }
  }

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ours = registered.filter((script) => script.id.startsWith(DYNAMIC_PREFIX));
  const stale = ours.filter((script) => !desired.has(script.id)).map((script) => script.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });

  for (const [id, definition] of desired) {
    const current = ours.find((script) => script.id === id);
    if (!current) {
      await chrome.scripting.registerContentScripts([definition]);
    } else if (
      JSON.stringify(current.matches) !== JSON.stringify(definition.matches)
      || JSON.stringify(current.js) !== JSON.stringify(definition.js)
      || current.runAt !== definition.runAt
    ) {
      await chrome.scripting.updateContentScripts([definition]);
    }
  }
}

async function getSnapshot(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const state = await readProfiles();
  const profiles = state.profiles
    .filter((profile) => matchesProfile(profile, identity.href))
    .map(runtimeProfile);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    revision: state.revision,
    documentId: identity.documentId,
    sessionId: String(message?.payload?.sessionId || ""),
    globalEnabled: state.globalEnabled,
    profiles
  };
}

async function requestManualRun(message, sender) {
  validatePanelSender(sender);
  const payload = message?.payload || {};
  const tabId = Number(payload.tabId);
  const profileId = String(payload.profileId || "");
  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isInteger(tabId) || !profileId || !Number.isFinite(expectedRevision)) {
    throw runtimeError("PROTOCOL_INVALID", "手动运行请求参数无效");
  }
  const tab = await chrome.tabs.get(tabId);
  const state = await readProfiles();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile || !matchesProfile(profile, tab.url || "")) {
    throw runtimeError("URL_MISMATCH", "规则与当前页面不匹配");
  }
  if (!state.globalEnabled) throw runtimeError("GLOBAL_DISABLED", "总开关已关闭");
  if (expectedRevision !== state.revision) throw runtimeError("REVISION_STALE", "页面规则版本已变化，请重新打开面板后重试");

  const grantId = createId("grant");
  await writeGrant({
    grantId,
    tabId,
    frameId: 0,
    profileId,
    revision: state.revision,
    expiresAt: Date.now() + GRANT_TTL_MS
  });
  const messageToContent = {
    protocolVersion: PROTOCOL_VERSION,
    type: "runtime.manualRunAuthorized",
    requestId: message.requestId || createId("request"),
    payload: { grantId, profileId, revision: state.revision }
  };
  try {
    try {
      const result = await chrome.tabs.sendMessage(tabId, messageToContent, { frameId: 0 });
      return { ...(result || {}), requestId: message.requestId || messageToContent.requestId };
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
      const result = await chrome.tabs.sendMessage(tabId, messageToContent, { frameId: 0 });
      return { ...(result || {}), requestId: message.requestId || messageToContent.requestId };
    }
  } finally {
    await chrome.storage.session.remove(grantKey(grantId));
  }
}

function leaseKey(runId) {
  return `${LEASE_KEY_PREFIX}${runId}`;
}

function grantKey(grantId) {
  return `${GRANT_KEY_PREFIX}${grantId}`;
}

async function readLease(runId) {
  if (!runId) return null;
  const key = leaseKey(runId);
  const stored = await chrome.storage.session.get(key);
  const lease = stored[key];
  if (!lease) return null;
  if (lease.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return lease;
}

async function writeLease(lease) {
  await chrome.storage.session.set({ [leaseKey(lease.runId)]: lease });
}

async function removeLease(runId) {
  if (runId) await chrome.storage.session.remove(leaseKey(runId));
}

async function writeGrant(grant) {
  await chrome.storage.session.set({ [grantKey(grant.grantId)]: grant });
}

async function readGrant(grantId) {
  if (!grantId) return null;
  const key = grantKey(grantId);
  const stored = await chrome.storage.session.get(key);
  const grant = stored[key];
  if (!grant) return null;
  if (grant.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return grant;
}

async function consumeGrant(grantId, identity, payload) {
  let consumed;
  const operation = grantWriteChain.catch(() => undefined).then(async () => {
    const grant = await readGrant(grantId);
    if (!grant
      || grant.tabId !== identity.tabId
      || grant.frameId !== identity.frameId
      || grant.profileId !== payload.profileId
      || grant.revision !== Number(payload.expectedRevision)) {
      throw runtimeError(grant ? "GRANT_INVALID" : "GRANT_EXPIRED", "手动运行授权已失效，请从面板重新测试");
    }
    await chrome.storage.session.remove(grantKey(grantId));
    consumed = grant;
  });
  grantWriteChain = operation.catch(() => undefined);
  await operation;
  return consumed;
}

async function startRun(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const state = await readProfiles();
  const payload = message?.payload || {};
  const profile = state.profiles.find((item) => item.id === payload.profileId);
  if (!profile || !matchesProfile(profile, identity.href)) throw runtimeError("URL_MISMATCH", "规则与当前页面不匹配");
  if (!state.globalEnabled) throw runtimeError("GLOBAL_DISABLED", "总开关已关闭");
  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isFinite(expectedRevision) || expectedRevision !== state.revision) {
    throw runtimeError("REVISION_STALE", "页面规则版本已变化，请重新获取配置");
  }
  if (payload.grantId) {
    await consumeGrant(String(payload.grantId), identity, { profileId: profile.id, expectedRevision });
  } else if (!profile.enabled) {
    throw runtimeError("PROFILE_DISABLED", "规则已停用");
  }
  const runId = createId("run");
  await writeLease({
    runId,
    tabId: identity.tabId,
    frameId: identity.frameId,
    documentId: identity.documentId,
    sessionId: String(payload.sessionId || ""),
    profileId: profile.id,
    revision: state.revision,
    expiresAt: Date.now() + LEASE_TTL_MS
  });
  return { ok: true, runId, revision: state.revision, documentId: identity.documentId };
}

async function getStepValue(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const payload = message?.payload || {};
  const lease = await readLease(payload.runId);
  if (!lease
    || lease.tabId !== identity.tabId
    || lease.frameId !== identity.frameId
    || lease.documentId !== identity.documentId
    || lease.profileId !== payload.profileId
    || lease.revision !== Number(payload.revision)) {
    throw runtimeError("RUN_STALE", "运行授权已失效");
  }
  const state = await readProfiles();
  if (state.revision !== lease.revision) throw runtimeError("REVISION_STALE", "规则版本已变化");
  const profile = state.profiles.find((item) => item.id === lease.profileId);
  if (!profile || !matchesProfile(profile, identity.href)) throw runtimeError("URL_MISMATCH", "规则与当前页面不匹配");
  const step = profile.steps.find((item) => item.id === payload.stepId);
  if (!step || !isValueBearingAction(step.action)) throw runtimeError("PROTOCOL_INVALID", "请求的步骤不允许按需读取值");
  lease.expiresAt = Date.now() + LEASE_TTL_MS;
  await writeLease(lease);
  return { ok: true, value: step.value ?? "" };
}

async function finishRun(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const runId = message?.payload?.runId;
  const lease = await readLease(runId);
  if (lease && lease.tabId === identity.tabId && lease.documentId === identity.documentId) {
    await removeLease(runId);
  }
  return { ok: true };
}

function appendRuntimeEvents(message, sender, sendResponse) {
  try {
    validateContentSender(sender);
  } catch (error) {
    sendResponse({ ok: false, code: error.code, message: error.message });
    return false;
  }
  const events = Array.isArray(message?.payload?.events) ? message.payload.events.slice(0, 100) : [];
  logWriteChain = logWriteChain.then(async () => {
    const stored = await chrome.storage.session.get(LOG_KEY);
    const current = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    const next = [...current, ...events
      .map(sanitizeRuntimeEvent)
      .filter((event) => !event.documentId || event.documentId === sender.documentId)]
      .slice(-MAX_LOGS);
    await chrome.storage.session.set({ [LOG_KEY]: next });
    return { ok: true, count: events.length };
  }).then(sendResponse).catch((error) => sendResponse({ ok: false, code: "LOG_WRITE_FAILED", message: error.message }));
  return true;
}

async function queryRuntimeLogs(message) {
  const stored = await chrome.storage.session.get(LOG_KEY);
  const limit = Math.max(1, Math.min(Number(message?.payload?.limit) || 100, 500));
  return { ok: true, events: (stored[LOG_KEY] || []).slice(-limit) };
}

async function clearRuntimeLogs() {
  await chrome.storage.session.set({ [LOG_KEY]: [] });
  return { ok: true };
}

async function initialize() {
  await ensureStorageAccess();
  await ensureStorage();
  await syncContentScripts();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function ensureInitialized() {
  if (!initializationPromise) initializationPromise = initialize();
  return initializationPromise;
}

async function handleMessage(message, sender) {
  if (!message || message.protocolVersion !== PROTOCOL_VERSION) {
    throw runtimeError("PROTOCOL_INVALID", "不支持的消息协议版本");
  }
  switch (message.type) {
    case "runtime.getSnapshot": return getSnapshot(message, sender);
    case "runtime.startRun": return startRun(message, sender);
    case "runtime.getStepValue": return getStepValue(message, sender);
    case "runtime.finishRun": return finishRun(message, sender);
    case "log.query": validatePanelSender(sender); return queryRuntimeLogs(message);
    case "log.clear": validatePanelSender(sender); return clearRuntimeLogs();
    default: throw runtimeError("PROTOCOL_INVALID", `未知消息：${message.type}`);
  }
}

chrome.runtime.onInstalled.addListener(() => ensureInitialized().catch(console.error));
chrome.runtime.onStartup.addListener(() => ensureInitialized().catch(console.error));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.profiles || changes.globalEnabled || changes.revision)) {
    syncContentScripts().catch(console.error);
    broadcastSnapshotUpdated(Number(changes.revision?.newValue) || 0).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "writeState") {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendResponse({ ok: false, code: "PROTOCOL_INVALID", message: "不支持的消息协议版本" });
      return false;
    }
    return writeState(message, sendResponse);
  }
  if (message?.type === "log.batch") {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendResponse({ ok: false, code: "PROTOCOL_INVALID", message: "不支持的消息协议版本" });
      return false;
    }
    return appendRuntimeEvents(message, sender, sendResponse);
  }
  if (message?.type === "runtime.requestManualRun") {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendResponse({ ok: false, code: "PROTOCOL_INVALID", message: "不支持的消息协议版本" });
      return false;
    }
    requestManualRun(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: error.code || "MANUAL_RUN_FAILED", message: error.message || "手动运行失败" }));
    return true;
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, code: error.code || "RUNTIME_ERROR", message: error.message || "运行时请求失败" }));
  return true;
});

ensureInitialized().catch(console.error);
