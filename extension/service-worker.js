importScripts("shared.js");

const {
  DEFAULT_ATRUST_PROFILE,
  copyProfile,
  normalizeOrigin,
  normalizeProfile
} = AutoFillShared;

const BASE_ORIGIN = "https://atrust.inforbus.com";
const DYNAMIC_PREFIX = "autofill-profile-";
let initializationPromise = null;

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

let writeChain = Promise.resolve();

function writeState(message, sendResponse) {
  writeChain = writeChain.then(async () => {
    await ensureInitialized();
    const expectedRevision = Number(message.expectedRevision);
    const stored = await chrome.storage.local.get("revision");
    const currentRevision = Number(stored.revision) || 0;
    if (Number.isFinite(expectedRevision) && expectedRevision !== currentRevision) {
      throw new Error("配置已被其他面板修改，请刷新后重试");
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
    return { ok: true, revision };
  }).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message || "配置写入失败" }));
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

async function initialize() {
  await ensureStorage();
  await syncContentScripts();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function ensureInitialized() {
  if (!initializationPromise) initializationPromise = initialize();
  return initializationPromise;
}

chrome.runtime.onInstalled.addListener(() => ensureInitialized().catch(console.error));
chrome.runtime.onStartup.addListener(() => ensureInitialized().catch(console.error));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.profiles) syncContentScripts().catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "writeState") return writeState(message, sendResponse);
  if (message?.type === "syncContentScripts") syncContentScripts().catch(console.error);
  return false;
});

ensureInitialized().catch(console.error);
