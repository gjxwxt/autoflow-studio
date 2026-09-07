(() => {
  if (window.__autoFillStudioLoaded) return;
  window.__autoFillStudioLoaded = true;

  const { matchesProfile, normalizeProfile, targetSummary } = AutoFillShared;
  const DEFAULTS = { profiles: [], activeProfileId: "", globalEnabled: true };
  let profiles = [];
  let globalEnabled = true;
  let pickerCleanup = null;
  let scheduled = false;
  let runKey = "";
  let running = false;

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function findByText(target) {
    if (!target.text) return null;
    const expected = cleanText(target.text);
    const candidates = document.querySelectorAll("button, [role=button], a, input[type=submit]");
    return [...candidates].find((element) => isVisible(element) && cleanText(element.innerText || element.value) === expected)
      || [...candidates].find((element) => isVisible(element) && cleanText(element.innerText || element.value).includes(expected))
      || null;
  }

  function findTarget(target = {}) {
    const selectors = [];
    if (target.id) selectors.push(`#${cssEscape(target.id)}`);
    if (target.name) selectors.push(`${target.tag || "*"}[name="${String(target.name).replace(/"/g, '\\"')}"]`);
    if (target.placeholder) selectors.push(`${target.tag || "input"}[placeholder="${String(target.placeholder).replace(/"/g, '\\"')}"]`);
    if (target.ariaLabel) selectors.push(`[aria-label="${String(target.ariaLabel).replace(/"/g, '\\"')}"]`);
    if (target.css) selectors.push(target.css);

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (isVisible(element)) return element;
      } catch {
        // An edited selector should not stop other selector strategies.
      }
    }
    return findByText(target);
  }

  async function waitForTarget(target, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = findTarget(target);
      if (element) return element;
      await wait(120);
    }
    return null;
  }

  function setValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function inputForLabel(element) {
    if (element?.tagName?.toLowerCase() !== "label") return element;
    if (element.htmlFor) return document.getElementById(element.htmlFor) || element;
    return element.querySelector("input, select, textarea") || element;
  }

  async function executeStep(step) {
    if (step.action === "delay") {
      await wait(Math.max(0, Math.min(Number(step.value) || 0, 30000)));
      return { ok: true };
    }

    const element = await waitForTarget(step.target, Math.max(1000, Math.min(Number(step.timeoutMs) || 12000, 30000)));
    if (!element) return { ok: false, message: `找不到：${step.label || targetSummary(step.target)}` };
    const input = inputForLabel(element);

    if (step.action === "wait") return { ok: true };
    if (step.action === "check") {
      const desired = step.value === true || step.value === "true" || step.value === 1;
      if (Boolean(input.checked) !== desired) input.click();
    } else if (step.action === "click") {
      input.click();
    } else if (step.action === "select" && input instanceof HTMLSelectElement) {
      const option = [...input.options].find((item) => item.value === String(step.value) || item.textContent.trim() === String(step.value));
      setValue(input, option ? option.value : step.value);
    } else if (step.action === "fill") {
      setValue(input, step.value ?? "");
    }
    return { ok: true };
  }

  function matchingProfile() {
    if (!globalEnabled) return null;
    return profiles
      .filter((profile) => profile.enabled && matchesProfile(profile, location.href))
      .sort((a, b) => `${b.site.pathPrefix}${b.site.hashPrefix}`.length - `${a.site.pathPrefix}${a.site.hashPrefix}`.length)[0] || null;
  }

  async function applyProfile(profile, force = false) {
    profile = normalizeProfile(profile);
    if (!force && (!profile.enabled || !matchesProfile(profile, location.href))) {
      return { ok: false, skipped: true, message: "规则未启用或不匹配当前页面" };
    }

    const key = `${profile.id}:${location.href}:${JSON.stringify(profile.steps)}`;
    if (!force && runKey === key) return { ok: true, alreadyRun: true, message: "规则已执行" };
    if (running) return { ok: false, message: "规则正在执行" };

    running = true;
    try {
      for (const step of profile.steps.filter((item) => item.enabled !== false)) {
        const result = await executeStep(step);
        if (!result.ok) return result;
      }
      runKey = key;
      return { ok: true, message: "流程已执行完成" };
    } finally {
      running = false;
    }
  }

  function scheduleAutoRun() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(async () => {
      scheduled = false;
      const profile = matchingProfile();
      if (profile) await applyProfile(profile).catch(() => undefined);
    }, 180);
  }

  function uniqueCssSelector(element) {
    if (element.id && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) return `#${cssEscape(element.id)}`;
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth += 1) {
      let part = current.tagName.toLowerCase();
      const usefulClasses = [...current.classList].filter((name) => /^[a-zA-Z][a-zA-Z0-9_-]{1,30}$/.test(name)).slice(0, 2);
      if (usefulClasses.length) part += usefulClasses.map((name) => `.${cssEscape(name)}`).join("");
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // Keep building a more specific path.
      }
      current = parent;
    }
    return parts.join(" > ");
  }

  function pickableElement(rawTarget) {
    if (!(rawTarget instanceof Element)) return null;
    const candidate = rawTarget.closest("input, textarea, select, button, a, label, [role=button], [role=checkbox], [contenteditable=true]") || rawTarget;
    return candidate.tagName.toLowerCase() === "label" ? inputForLabel(candidate) : candidate;
  }

  function describeElement(element) {
    const tag = element.tagName.toLowerCase();
    return {
      tag,
      id: element.id || "",
      name: element.getAttribute("name") || "",
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      role: element.getAttribute("role") || "",
      type: element.getAttribute("type") || "",
      text: cleanText(element.innerText || element.value).slice(0, 80),
      css: uniqueCssSelector(element)
    };
  }

  function startPicker(requestId, purpose = "field") {
    if (pickerCleanup) pickerCleanup();
    const overlay = document.createElement("div");
    overlay.dataset.autoFillPicker = "true";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:9px 13px;border-radius:9px;background:#241c2d;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 7px 24px rgba(20,12,30,.25);pointer-events:none;";
    bar.textContent = purpose === "trigger" ? "选择触发按钮，按 Esc 取消" : "选择要配置的页面元素，按 Esc 取消";
    const highlight = document.createElement("div");
    highlight.style.cssText = "position:fixed;display:none;border:2px solid #a73379;border-radius:5px;background:rgba(167,51,121,.10);pointer-events:none;transition:all 80ms ease-out;";
    overlay.append(bar, highlight);
    document.documentElement.append(overlay);

    let hovered = null;
    const move = (event) => {
      const element = pickableElement(event.target);
      if (!element || element === overlay || element === bar || element === document.documentElement || element === document.body) return;
      hovered = element;
      const rect = element.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.left = `${rect.left - 2}px`;
      highlight.style.top = `${rect.top - 2}px`;
      highlight.style.width = `${rect.width + 4}px`;
      highlight.style.height = `${rect.height + 4}px`;
      bar.textContent = `${purpose === "trigger" ? "触发按钮" : "字段"}：${targetSummary(describeElement(element))}，点击确认`;
    };
    const click = (event) => {
      if (!hovered) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = describeElement(hovered);
      cleanup();
      chrome.runtime.sendMessage({ type: "pickerResult", requestId, purpose, target }).catch(() => undefined);
    };
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        chrome.runtime.sendMessage({ type: "pickerCancelled", requestId }).catch(() => undefined);
      }
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keydown, true);
      overlay.remove();
      pickerCleanup = null;
    };
    pickerCleanup = cleanup;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keydown, true);
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    profiles = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
    globalEnabled = stored.globalEnabled !== false;
    scheduleAutoRun();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.profiles) {
      profiles = Array.isArray(changes.profiles.newValue) ? changes.profiles.newValue.map(normalizeProfile) : [];
      runKey = "";
    }
    if (changes.globalEnabled) {
      globalEnabled = changes.globalEnabled.newValue !== false;
      runKey = "";
    }
    if (changes.profiles || changes.globalEnabled) scheduleAutoRun();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "startPicker") {
      startPicker(message.requestId, message.purpose);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "cancelPicker") {
      pickerCleanup?.();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "getPageInfo") {
      sendResponse({ ok: true, url: location.href, title: document.title });
      return false;
    }
    if (message?.type === "applyProfile") {
      applyProfile(message.profile, true).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(scheduleAutoRun);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });
  loadSettings();
})();
