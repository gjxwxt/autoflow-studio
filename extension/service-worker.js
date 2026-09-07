importScripts("shared.js");

const {
  DEFAULT_ATRUST_PROFILE,
  copyProfile,
  normalizeOrigin,
  normalizeProfile
} = AutoFillShared;

const BASE_ORIGIN = "https://atrust.inforbus.com";
const DYNAMIC_PREFIX = "autofill-profile-";

async function ensureStorage() {
  const stored = await chrome.storage.local.get(["profiles", "globalEnabled", "enabled", "username", "password", "schemaVersion"]);
  if (Array.isArray(stored.profiles)) {
    const normalizedProfiles = stored.profiles.map(normalizeProfile);
    const updates = {
      schemaVersion: Math.max(3, Number(stored.schemaVersion) || 0),
      profiles: normalizedProfiles
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
    globalEnabled: typeof stored.globalEnabled === "boolean" ? stored.globalEnabled : true
  });
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

chrome.runtime.onInstalled.addListener(() => initialize().catch(console.error));
chrome.runtime.onStartup.addListener(() => initialize().catch(console.error));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.profiles) syncContentScripts().catch(console.error);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "syncContentScripts") syncContentScripts().catch(console.error);
});

initialize().catch(console.error);
