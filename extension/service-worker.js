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
const LEASE_KEY = "runtimeLeases";
const MAX_LOGS = 500;
const LEASE_TTL_MS = 10 * 60 * 1000;
let initializationPromise = null;
let writeChain = Promise.resolve();
let logWriteChain = Promise.resolve();

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
    return;
  }

  const profile = copyProfile(DEFAULT_ATRUST_PROFILE);
  profile.enabled = Boolean(stored.enabled);
  profile.steps[0].value = stored.username || "";
  profile.steps[1].value = stored.password || "";
  await chrome.storage.local.set({
    schemaVersion: 3,
    profiles: [profile],
    activeProfileId: profile.id,
    globalEnabled: typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : true,
    revision: 1
  });
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

async function readLeases() {
  const stored = await chrome.storage.session.get(LEASE_KEY);
  const now = Date.now();
  const previous = stored[LEASE_KEY] || {};
  const leases = Object.fromEntries(Object.entries(previous).filter(([, lease]) => lease?.expiresAt > now));
  if (Object.keys(leases).length !== Object.keys(previous).length) {
    await chrome.storage.session.set({ [LEASE_KEY]: leases });
  }
  return leases;
}

async function startRun(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const state = await readProfiles();
  const payload = message?.payload || {};
  const profile = state.profiles.find((item) => item.id === payload.profileId);
  if (!profile || !matchesProfile(profile, identity.href)) throw runtimeError("URL_MISMATCH", "规则与当前页面不匹配");
  if (!state.globalEnabled) throw runtimeError("GLOBAL_DISABLED", "总开关已关闭");
  const manual = payload.reason === "manual";
  if (!manual && !profile.enabled) throw runtimeError("PROFILE_DISABLED", "规则已停用");
  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isFinite(expectedRevision) || expectedRevision !== state.revision) {
    throw runtimeError("REVISION_STALE", "页面规则版本已变化，请重新获取配置");
  }
  const runId = createId("run");
  const leases = await readLeases();
  leases[runId] = {
    runId,
    tabId: identity.tabId,
    frameId: identity.frameId,
    documentId: identity.documentId,
    sessionId: String(payload.sessionId || ""),
    profileId: profile.id,
    revision: state.revision,
    expiresAt: Date.now() + LEASE_TTL_MS
  };
  await chrome.storage.session.set({ [LEASE_KEY]: leases });
  return { ok: true, runId, revision: state.revision, documentId: identity.documentId };
}

async function getStepValue(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const payload = message?.payload || {};
  const leases = await readLeases();
  const lease = leases[payload.runId];
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
  await chrome.storage.session.set({ [LEASE_KEY]: leases });
  return { ok: true, value: step.value ?? "" };
}

async function finishRun(message, sender) {
  const identity = await validateRuntimeSender(sender);
  const leases = await readLeases();
  const lease = leases[message?.payload?.runId];
  if (lease && lease.tabId === identity.tabId && lease.documentId === identity.documentId) {
    delete leases[message.payload.runId];
    await chrome.storage.session.set({ [LEASE_KEY]: leases });
  }
  return { ok: true };
}

function appendRuntimeEvents(message, sendResponse) {
  const events = Array.isArray(message?.payload?.events) ? message.payload.events.slice(0, 100) : [];
  logWriteChain = logWriteChain.then(async () => {
    const stored = await chrome.storage.session.get(LOG_KEY);
    const current = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    const next = [...current, ...events.map(sanitizeRuntimeEvent)].slice(-MAX_LOGS);
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
    case "log.query": return queryRuntimeLogs(message);
    case "log.clear": return clearRuntimeLogs();
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
  if (message?.type === "writeState") return writeState(message, sendResponse);
  if (message?.type === "syncContentScripts") {
    syncContentScripts().catch(console.error);
    return false;
  }
  if (message?.type === "log.batch") {
    return appendRuntimeEvents(message, sendResponse);
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, code: error.code || "RUNTIME_ERROR", message: error.message || "运行时请求失败" }));
  return true;
});

ensureInitialized().catch(console.error);
