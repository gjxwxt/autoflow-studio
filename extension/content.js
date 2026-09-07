(() => {
  if (window.__autoFillStudioLoaded) return;
  window.__autoFillStudioLoaded = true;

  const { matchesProfile, normalizeProfile, targetSummary } = AutoFillShared;
  const DEFAULTS = { profiles: [], activeProfileId: "", globalEnabled: true };
  let profiles = [];
  let globalEnabled = true;
  let pickerCleanup = null;
  let scanTimer = 0;
  let lastUrl = location.href;
  let drainingQueue = false;
  const runQueue = [];
  const ruleStates = new Map();

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && style.opacity !== "0";
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function findByText(target, requireVisible = true) {
    if (!target.text) return null;
    const expected = cleanText(target.text);
    const candidates = document.querySelectorAll("button, [role=button], a, input[type=submit]");
    const usable = [...candidates].filter((element) => !requireVisible || isVisible(element));
    return usable.find((element) => cleanText(element.innerText || element.value) === expected)
      || usable.find((element) => cleanText(element.innerText || element.value).includes(expected))
      || null;
  }

  function findTarget(target = {}, { requireVisible = true } = {}) {
    const selectors = [];
    if (target.id) selectors.push(`#${cssEscape(target.id)}`);
    if (target.name) selectors.push(`${target.tag || "*"}[name="${String(target.name).replace(/"/g, '\\"')}"]`);
    if (target.placeholder) selectors.push(`${target.tag || "input"}[placeholder="${String(target.placeholder).replace(/"/g, '\\"')}"]`);
    if (target.ariaLabel) selectors.push(`[aria-label="${String(target.ariaLabel).replace(/"/g, '\\"')}"]`);
    if (target.css) selectors.push(target.css);

    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element && (!requireVisible || isVisible(element))) return element;
      } catch {
        // An edited selector should not stop other selector strategies.
      }
    }
    return findByText(target, requireVisible);
  }

  async function waitForTarget(target, timeoutMs = 8000, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("流程已取消", "AbortError");
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

  const ACTION_HANDLERS = Object.freeze({
    wait: async () => ({ ok: true }),
    check: async ({ input, step }) => {
      const desired = step.value === true || step.value === "true" || step.value === 1;
      if (Boolean(input.checked) !== desired) input.click();
      return { ok: true };
    },
    click: async ({ input }) => {
      input.click();
      return { ok: true };
    },
    select: async ({ input, step }) => {
      if (!(input instanceof HTMLSelectElement)) return { ok: false, message: "目标元素不是下拉框" };
      const option = [...input.options].find((item) => item.value === String(step.value) || item.textContent.trim() === String(step.value));
      setValue(input, option ? option.value : step.value);
      return { ok: true };
    },
    fill: async ({ input, step }) => {
      setValue(input, step.value ?? "");
      return { ok: true };
    }
  });

  async function executeStep(step, signal) {
    if (step.action === "delay") {
      if (signal?.aborted) throw new DOMException("流程已取消", "AbortError");
      await wait(Math.max(0, Math.min(Number(step.value) || 0, 30000)));
      return { ok: true };
    }

    const element = await waitForTarget(step.target, Math.max(1000, Math.min(Number(step.timeoutMs) || 12000, 30000)), signal);
    if (!element) return { ok: false, message: `找不到：${step.label || targetSummary(step.target)}` };
    const input = inputForLabel(element);
    const handler = ACTION_HANDLERS[step.action];
    if (!handler) return { ok: false, message: `不支持的动作：${step.action}` };
    return handler({ element, input, step, signal });
  }

  function matchingProfiles() {
    if (!globalEnabled) return [];
    return profiles
      .filter((profile) => profile.enabled && matchesProfile(profile, location.href))
      .sort((a, b) => `${b.site.pathPrefix}${b.site.hashPrefix}`.length - `${a.site.pathPrefix}${a.site.hashPrefix}`.length);
  }

  function ruleState(profile) {
    const signature = JSON.stringify({ trigger: profile.trigger, steps: profile.steps });
    const previous = ruleStates.get(profile.id);
    if (previous?.signature === signature) return previous;
    previous?.controller?.abort();
    const next = {
      signature,
      phase: "armed",
      wasSatisfied: false,
      runCount: 0,
      queued: false,
      cooldownUntil: 0,
      controller: null,
      lastMessage: ""
    };
    ruleStates.set(profile.id, next);
    return next;
  }

  function resetRuntimeStates() {
    for (const state of ruleStates.values()) state.controller?.abort();
    ruleStates.clear();
    runQueue.length = 0;
  }

  function canQueue(profile, state) {
    const options = profile.trigger?.options || {};
    if (["queued", "running", "cooldown", "failed"].includes(state.phase)) return false;
    if (Date.now() < state.cooldownUntil) return false;
    if (state.runCount >= Math.max(1, Number(options.maxRuns) || 1)) return false;
    if (options.oncePerPage !== false && state.runCount > 0) return false;
    return true;
  }

  function queueProfile(profile, reason = "condition") {
    if (!globalEnabled || !profile?.enabled || !matchesProfile(profile, location.href)) return false;
    const state = ruleState(profile);
    if (!canQueue(profile, state)) return false;
    state.phase = "queued";
    state.queued = true;
    runQueue.push({ profile, state, reason });
    drainQueue().catch(() => undefined);
    return true;
  }

  async function executeProfile(profile, state, reason = "condition") {
    const controller = new AbortController();
    state.controller = controller;
    state.phase = "running";
    state.queued = false;
    try {
      for (const step of profile.steps.filter((item) => item.enabled !== false)) {
        const result = await executeStep(step, controller.signal);
        if (!result.ok) {
          state.phase = "failed";
          state.lastMessage = result.message || "流程执行失败";
          return result;
        }
      }
      state.runCount += 1;
      state.lastMessage = "流程已执行完成";
      const options = profile.trigger?.options || {};
      state.cooldownUntil = Date.now() + Math.max(0, Number(options.cooldownMs) || 0);
      state.phase = state.cooldownUntil > Date.now() ? "cooldown" : "completed";
      if (state.phase === "cooldown") {
        window.setTimeout(() => {
          if (state.phase !== "cooldown") return;
          state.phase = "completed";
          scheduleAutoRun();
        }, Math.max(0, Number(options.cooldownMs) || 0));
      }
      return { ok: true, message: "流程已执行完成", reason };
    } catch (error) {
      if (error?.name === "AbortError") return { ok: false, cancelled: true, message: "流程已取消" };
      state.phase = "failed";
      state.lastMessage = error?.message || "流程执行失败";
      return { ok: false, message: state.lastMessage };
    } finally {
      state.controller = null;
      if (state.phase === "running") state.phase = "failed";
      scheduleAutoRun();
    }
  }

  async function drainQueue() {
    if (drainingQueue) return;
    drainingQueue = true;
    try {
      while (runQueue.length) {
        const item = runQueue.shift();
        if (!item) continue;
        const { profile, state } = item;
        if (!globalEnabled || !profile.enabled || !matchesProfile(profile, location.href)) {
          state.phase = "armed";
          state.queued = false;
          continue;
        }
        await executeProfile(profile, state, item.reason);
      }
    } finally {
      drainingQueue = false;
    }
  }

  function evaluateElementVisible(profile, state) {
    const satisfied = Boolean(findTarget(profile.trigger?.target, { requireVisible: true }));
    const becameSatisfied = !state.wasSatisfied && satisfied;
    state.wasSatisfied = satisfied;
    const options = profile.trigger?.options || {};
    if (becameSatisfied && (state.runCount === 0 || options.retriggerWhenReappears)) {
      queueProfile(profile, "elementVisible");
    }
  }

  const TRIGGER_HANDLERS = Object.freeze({
    pageLoad: {
      onScan: ({ profile, state }) => {
        if (state.runCount === 0) queueProfile(profile, "pageLoad");
      }
    },
    elementVisible: {
      onScan: ({ profile, state }) => evaluateElementVisible(profile, state)
    },
    userClick: {
      matchesEvent: ({ event, profile }) => eventMatchesTarget(event, profile.trigger.target)
    }
  });

  function evaluateRules() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      resetRuntimeStates();
    }
    if (!globalEnabled) return;
    for (const profile of matchingProfiles()) {
      const state = ruleState(profile);
      const triggerType = profile.trigger?.type || "pageLoad";
      TRIGGER_HANDLERS[triggerType]?.onScan?.({ profile, state });
    }
  }

  function scheduleAutoRun() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(evaluateRules, 120);
  }

  function targetMatchesElement(element, target = {}) {
    if (!(element instanceof Element)) return false;
    if (target.id && element.id === target.id) return true;
    if (target.name && element.getAttribute("name") === target.name) return true;
    if (target.placeholder && element.getAttribute("placeholder") === target.placeholder) return true;
    if (target.ariaLabel && element.getAttribute("aria-label") === target.ariaLabel) return true;
    if (target.css) {
      try {
        if (element.matches(target.css)) return true;
      } catch {
        // Ignore edited selectors and continue with stable attributes.
      }
    }
    return Boolean(target.text && cleanText(element.innerText || element.value).includes(cleanText(target.text)));
  }

  function eventMatchesTarget(event, target) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    return path.some((element) => targetMatchesElement(element, target));
  }

  function handleUserClick(event) {
    if (!globalEnabled) return;
    for (const profile of matchingProfiles()) {
      const handler = TRIGGER_HANDLERS[profile.trigger?.type];
      if (handler?.matchesEvent?.({ event, profile })) queueProfile(profile, "userClick");
    }
  }

  function resetForNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    resetRuntimeStates();
    scheduleAutoRun();
  }

  function patchHistoryNavigation() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (original.__autoFlowPatched) continue;
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        window.queueMicrotask(resetForNavigation);
        return result;
      };
      wrapped.__autoFlowPatched = true;
      history[method] = wrapped;
    }
    window.addEventListener("hashchange", resetForNavigation, true);
    window.addEventListener("popstate", resetForNavigation, true);
  }

  async function applyProfile(profile, force = false) {
    const normalized = normalizeProfile(profile);
    if (!force && (!normalized.enabled || !globalEnabled || !matchesProfile(normalized, location.href))) {
      return { ok: false, skipped: true, message: "规则未启用或不匹配当前页面" };
    }
    const state = ruleState(normalized);
    if (!force) {
      queueProfile(normalized, "automatic");
      return { ok: true, queued: true, message: "规则已加入执行队列" };
    }
    if (state.phase === "running") return { ok: false, message: "规则正在执行" };
    state.runCount = 0;
    state.phase = "armed";
    return executeProfile(normalized, state, "manual");
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
    resetRuntimeStates();
    scheduleAutoRun();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.profiles) {
      profiles = Array.isArray(changes.profiles.newValue) ? changes.profiles.newValue.map(normalizeProfile) : [];
      resetRuntimeStates();
    }
    if (changes.globalEnabled) {
      globalEnabled = changes.globalEnabled.newValue !== false;
      resetRuntimeStates();
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
  const observeDocument = () => {
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
      return;
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled"]
    });
  };
  observeDocument();
  document.addEventListener("DOMContentLoaded", scheduleAutoRun, { once: true });
  window.addEventListener("load", scheduleAutoRun, { once: true });
  document.addEventListener("click", handleUserClick, true);
  patchHistoryNavigation();
  loadSettings();
})();
