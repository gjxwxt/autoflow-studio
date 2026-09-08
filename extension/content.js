(() => {
  if (window.__autoFillStudioLoaded) return;
  window.__autoFillStudioLoaded = true;

  const {
    PROTOCOL_VERSION,
    createId,
    isSupportedProfile,
    isValueBearingAction,
    matchesProfile,
    normalizeProfile,
    sanitizeRuntimeEvent,
    targetSummary
  } = AutoFillShared;
  let profiles = [];
  let globalEnabled = true;
  let runtimeSnapshot = null;
  let snapshotRequest = null;
  const sessionId = globalThis.crypto?.randomUUID?.() || createId("session");
  let eventSeq = 0;
  let pendingEvents = [];
  let eventTimer = 0;
  let deferPageLoadUntilNavigation = false;
  let pickerCleanup = null;
  let scanTimer = 0;
  let scanMaxTimer = 0;
  let navigationTimer = 0;
  let scanDirty = false;
  let lastUrl = location.href;
  let drainingQueue = false;
  let runtimeGeneration = 0;
  let nextRunToken = 0;
  const runQueue = [];
  const ruleStates = new Map();
  const deferredPageLoadIds = new Set();

  function emitRuntimeEvent(event, details = {}) {
    const item = sanitizeRuntimeEvent({
      timestamp: Date.now(),
      seq: ++eventSeq,
      event,
      page: location.href,
      documentId: runtimeSnapshot?.documentId || "",
      sessionId,
      revision: runtimeSnapshot?.revision || 0,
      ...details
    });
    pendingEvents.push(item);
    if (pendingEvents.length >= 20) flushRuntimeEvents();
    else if (!eventTimer) eventTimer = window.setTimeout(flushRuntimeEvents, 100);
  }

  function flushRuntimeEvents() {
    window.clearTimeout(eventTimer);
    eventTimer = 0;
    if (!pendingEvents.length) return;
    const events = pendingEvents.splice(0, 100);
    chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "log.batch",
      payload: { events }
    }).catch(() => undefined);
  }

  async function requestSnapshot({ deferPageLoad = false } = {}) {
    if (snapshotRequest) return snapshotRequest;
    snapshotRequest = chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "runtime.getSnapshot",
      payload: { sessionId }
    }).then((result) => {
      if (!result?.ok) {
        const error = new Error(result?.message || "无法读取当前页面规则");
        error.code = result?.code || "SNAPSHOT_FAILED";
        throw error;
      }
      runtimeSnapshot = result;
      profiles = Array.isArray(result.profiles) ? result.profiles.map(normalizeProfile).filter(isSupportedProfile) : [];
      globalEnabled = result.globalEnabled !== false;
      deferPageLoadUntilNavigation = deferPageLoad;
      resetRuntimeStates();
      if (deferPageLoad && globalEnabled) {
        for (const profile of matchingProfiles()) {
          const triggerType = profile.trigger?.type || "pageLoad";
          if (triggerType === "pageLoad") deferredPageLoadIds.add(profile.id);
          if (triggerType === "elementVisible") {
            ruleState(profile).wasSatisfied = Boolean(findTarget(profile.trigger?.target, { requireVisible: true }));
          }
        }
      }
      emitRuntimeEvent("runtime.session.snapshot", { context: { profileCount: profiles.length } });
      scheduleAutoRun();
      return result;
    }).finally(() => {
      snapshotRequest = null;
    });
    return snapshotRequest;
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("流程已取消", "AbortError"));
        return;
      }
      const timer = window.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("流程已取消", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

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

  function findTargetCandidates(target = {}, { requireVisible = true } = {}) {
    const selectors = [];
    if (target.id) selectors.push(`#${cssEscape(target.id)}`);
    if (target.name) selectors.push(`${target.tag || "*"}[name="${String(target.name).replace(/"/g, '\\"')}"]`);
    if (target.placeholder) selectors.push(`${target.tag || "input"}[placeholder="${String(target.placeholder).replace(/"/g, '\\"')}"]`);
    if (target.ariaLabel) selectors.push(`[aria-label="${String(target.ariaLabel).replace(/"/g, '\\"')}"]`);
    if (target.css) selectors.push(target.css);

    const candidates = new Set();
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) candidates.add(element);
      } catch {
        // An edited selector should not stop other selector strategies.
      }
    }
    if (target.text) {
      const expected = cleanText(target.text);
      const textCandidates = document.querySelectorAll("button, [role=button], a, input[type=submit]");
      for (const element of textCandidates) {
        const text = cleanText(element.innerText || element.value);
        if (text === expected || text.includes(expected)) candidates.add(element);
      }
    }
    return [...candidates].filter((element) => !requireVisible || isVisible(element));
  }

  function resolveTarget(target = {}, options = {}) {
    const candidates = findTargetCandidates(target, options);
    if (!candidates.length) return { status: "notFound", candidates };
    if (options.unique && candidates.length > 1) return { status: "ambiguous", candidates };
    return { status: "resolved", element: candidates[0], candidates };
  }

  function findTarget(target = {}, { requireVisible = true } = {}) {
    return resolveTarget(target, { requireVisible }).element || null;
  }

  async function waitForTarget(target, timeoutMs = 8000, signal, { unique = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("流程已取消", "AbortError");
      const resolution = resolveTarget(target, { unique });
      if (resolution.status === "resolved") return unique ? resolution : resolution.element;
      if (resolution.status === "ambiguous") return resolution;
      await wait(120, signal);
    }
    return unique ? { status: "notFound", candidates: [] } : null;
  }

  function setValue(element, value, guard = () => undefined) {
    guard();
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    guard();
    element.dispatchEvent(new Event("input", { bubbles: true }));
    guard();
    element.dispatchEvent(new Event("change", { bubbles: true }));
    guard();
  }

  function inputForLabel(element) {
    if (element?.tagName?.toLowerCase() !== "label") return element;
    if (element.htmlFor) return document.getElementById(element.htmlFor) || element;
    return element.querySelector("input, select, textarea") || element;
  }

  const ACTION_HANDLERS = Object.freeze({
    wait: async ({ guard }) => { guard(); return { ok: true }; },
    check: async ({ input, step, guard }) => {
      guard();
      const desired = step.value === true || step.value === "true" || step.value === 1;
      if (Boolean(input.checked) !== desired) {
        guard();
        input.click();
        guard();
      }
      return { ok: true };
    },
    click: async ({ input, guard }) => {
      guard();
      input.click();
      guard();
      return { ok: true };
    },
    select: async ({ input, step, guard }) => {
      guard();
      if (!(input instanceof HTMLSelectElement)) return { ok: false, message: "目标元素不是下拉框" };
      const option = [...input.options].find((item) => item.value === String(step.value) || item.textContent.trim() === String(step.value));
      setValue(input, option ? option.value : step.value, guard);
      return { ok: true };
    },
    fill: async ({ input, step, guard }) => {
      setValue(input, step.value ?? "", guard);
      return { ok: true };
    }
  });

  async function getStepValue(runContext, step, guard) {
    if (!isValueBearingAction(step.action)) return step.value;
    const result = await chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "runtime.getStepValue",
      payload: {
        runId: runContext.runId,
        profileId: runContext.profileId,
        stepId: step.id,
        revision: runContext.revision
      }
    });
    guard();
    if (!result?.ok) {
      const error = new Error(result?.message || "无法读取当前步骤值");
      error.code = result?.code || "STEP_VALUE_FAILED";
      throw error;
    }
    return result.value;
  }

  async function executeStep(step, signal, guard = () => undefined, runContext) {
    const value = await getStepValue(runContext, step, guard);
    const resolvedStep = value === step.value ? step : { ...step, value };
    if (resolvedStep.action === "delay") {
      guard();
      const delayMs = Number.isFinite(Number(resolvedStep.value)) ? Math.max(0, Math.min(Number(resolvedStep.value), 30000)) : 0;
      await wait(delayMs, signal);
      guard();
      return { ok: true };
    }

    const unique = ["fill", "click", "check", "select"].includes(resolvedStep.action);
    const resolution = await waitForTarget(
      resolvedStep.target,
      Math.max(1000, Math.min(Number(resolvedStep.timeoutMs) || 12000, 30000)),
      signal,
      { unique }
    );
    guard();
    if (!resolution || resolution.status === "notFound") {
      emitRuntimeEvent("locator.not_found", { level: "warn", code: "LOCATOR_NOT_FOUND", stepId: resolvedStep.id, runId: runContext?.runId });
      return { ok: false, code: "LOCATOR_NOT_FOUND", message: `找不到：${resolvedStep.label || targetSummary(resolvedStep.target)}` };
    }
    if (resolution.status === "ambiguous") {
      emitRuntimeEvent("locator.ambiguous", { level: "warn", code: "LOCATOR_AMBIGUOUS", stepId: resolvedStep.id, runId: runContext?.runId, context: { matches: resolution.candidates.length } });
      return { ok: false, code: "LOCATOR_AMBIGUOUS", message: `目标不唯一：${resolvedStep.label || targetSummary(resolvedStep.target)}` };
    }
    const element = unique ? resolution.element : resolution;
    emitRuntimeEvent("locator.resolved", { stepId: resolvedStep.id, runId: runContext?.runId, context: { matches: unique ? resolution.candidates.length : 1 } });
    const input = inputForLabel(element);
    const handler = ACTION_HANDLERS[resolvedStep.action];
    if (!handler) return { ok: false, code: "ACTION_UNSUPPORTED", message: `不支持的动作：${resolvedStep.action}` };
    return handler({ element, input, step: resolvedStep, signal, guard });
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
      generation: runtimeGeneration,
      token: Symbol(profile.id),
      signature,
      phase: "armed",
      wasSatisfied: false,
      runCount: 0,
      queued: false,
      pendingActivation: false,
      cooldownUntil: 0,
      controller: null,
      cooldownTimer: 0,
      runToken: 0,
      runId: "",
      revision: 0,
      documentId: "",
      lastMessage: ""
    };
    ruleStates.set(profile.id, next);
    return next;
  }

  function resetRuntimeStates({ clearDeferred = true } = {}) {
    runtimeGeneration += 1;
    for (const state of ruleStates.values()) {
      state.controller?.abort();
      if (state.cooldownTimer) window.clearTimeout(state.cooldownTimer);
    }
    ruleStates.clear();
    for (const item of runQueue) {
      releaseRun(item.runId);
      item.resolve?.({ ok: false, cancelled: true, message: "流程已取消" });
    }
    runQueue.length = 0;
    if (clearDeferred) deferredPageLoadIds.clear();
    window.clearTimeout(scanTimer);
    window.clearTimeout(scanMaxTimer);
    scanTimer = 0;
    scanMaxTimer = 0;
    scanDirty = false;
    emitRuntimeEvent("runtime.state.reset");
  }

  function canQueue(profile, state, manual = false) {
    const options = profile.trigger?.options || {};
    if (["authorizing", "queued", "running"].includes(state.phase)) return false;
    if (manual) return true;
    if (["cooldown", "failed"].includes(state.phase)) return false;
    if (Date.now() < state.cooldownUntil) return false;
    if (state.runCount >= Math.max(1, Number(options.maxRuns) || 1)) return false;
    if (options.oncePerPage !== false && state.runCount > 0) return false;
    return true;
  }

  async function authorizeRun(profile, reason, manual) {
    if (!runtimeSnapshot) await requestSnapshot();
    const result = await chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "runtime.startRun",
      payload: {
        profileId: profile.id,
        expectedRevision: runtimeSnapshot?.revision || 0,
        sessionId,
        reason: manual ? "manual" : reason
      }
    });
    if (!result?.ok) {
      const error = new Error(result?.message || "运行授权失败");
      error.code = result?.code || "RUN_AUTHORIZATION_FAILED";
      throw error;
    }
    return result;
  }

  async function releaseRun(runId) {
    if (!runId) return;
    chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: "runtime.finishRun",
      payload: { runId }
    }).catch(() => undefined);
  }

  async function queueProfile(profile, reason = "condition", { manual = false, resetCount = false, waitForResult = false } = {}) {
    if (!globalEnabled || !profile || (!manual && !profile.enabled) || !matchesProfile(profile, location.href)) return false;
    const state = ruleState(profile);
    if (["authorizing", "queued", "running"].includes(state.phase)) return false;
    if (resetCount) {
      if (state.cooldownTimer) window.clearTimeout(state.cooldownTimer);
      state.cooldownTimer = 0;
      state.runCount = 0;
      state.cooldownUntil = 0;
      state.phase = "armed";
    }
    if (!canQueue(profile, state, manual)) return false;
    state.phase = "authorizing";
    state.queued = false;
    let authorization;
    try {
      authorization = await authorizeRun(profile, reason, manual);
    } catch (error) {
      state.phase = "armed";
      state.lastMessage = error.message || "运行授权失败";
      emitRuntimeEvent("scheduler.skipped", {
        level: "warn",
        code: error.code || "RUN_AUTHORIZATION_FAILED",
        profileId: profile.id,
        context: { reason }
      });
      return false;
    }
    if (runtimeGeneration !== state.generation || ruleStates.get(profile.id) !== state) {
      await releaseRun(authorization.runId);
      state.phase = "cancelled";
      return false;
    }
    state.phase = "queued";
    state.queued = true;
    const item = {
      profile,
      state,
      reason,
      manual,
      generation: runtimeGeneration,
      runId: authorization.runId,
      revision: authorization.revision,
      documentId: authorization.documentId
    };
    const completion = waitForResult
      ? new Promise((resolve) => { item.resolve = resolve; })
      : null;
    runQueue.push(item);
    emitRuntimeEvent("scheduler.queued", { profileId: profile.id, runId: item.runId, context: { reason } });
    drainQueue().catch(() => undefined);
    return completion ? { queued: true, promise: completion } : true;
  }

  function isCurrentRun(profile, state, runToken, generation, pageHref) {
    return runtimeGeneration === generation
      && ruleStates.get(profile.id) === state
      && state.runToken === runToken
      && state.runId
      && runtimeSnapshot?.revision === state.revision
      && runtimeSnapshot?.documentId === state.documentId
      && location.href === pageHref
      && matchesProfile(profile, location.href);
  }

  async function executeProfile(profile, state, reason = "condition", generation = runtimeGeneration, runContext) {
    const controller = new AbortController();
    const runToken = ++nextRunToken;
    const pageHref = location.href;
    state.controller = controller;
    state.runToken = runToken;
    state.runId = runContext.runId;
    state.revision = runContext.revision;
    state.documentId = runContext.documentId;
    state.phase = "running";
    state.queued = false;
    const startedAt = Date.now();
    emitRuntimeEvent("run.started", { profileId: profile.id, runId: runContext.runId, context: { reason } });
    try {
      for (const step of profile.steps.filter((item) => item.enabled !== false)) {
        const guard = () => {
          if (controller.signal.aborted || !isCurrentRun(profile, state, runToken, generation, pageHref)) {
            throw new DOMException("流程已取消", "AbortError");
          }
        };
        guard();
        const stepStartedAt = Date.now();
        emitRuntimeEvent("step.started", { profileId: profile.id, stepId: step.id, runId: runContext.runId, context: { action: step.action } });
        const result = await executeStep(step, controller.signal, guard, runContext);
        if (!isCurrentRun(profile, state, runToken, generation, pageHref)) throw new DOMException("流程已取消", "AbortError");
        if (!result.ok) {
          state.phase = "failed";
          state.lastMessage = result.message || "流程执行失败";
          emitRuntimeEvent("step.failed", {
            level: "warn",
            code: result.code || "ACTION_FAILED",
            profileId: profile.id,
            stepId: step.id,
            runId: runContext.runId,
            durationMs: Date.now() - stepStartedAt
          });
          return result;
        }
        emitRuntimeEvent("step.succeeded", {
          profileId: profile.id,
          stepId: step.id,
          runId: runContext.runId,
          durationMs: Date.now() - stepStartedAt,
          context: { action: step.action }
        });
      }
      state.runCount += 1;
      state.lastMessage = "流程已执行完成";
      const options = profile.trigger?.options || {};
      state.cooldownUntil = Date.now() + Math.max(0, Number(options.cooldownMs) || 0);
      state.phase = state.cooldownUntil > Date.now() ? "cooldown" : "completed";
      if (state.phase === "cooldown") {
        state.cooldownTimer = window.setTimeout(() => {
          if (!isCurrentRun(profile, state, runToken, generation, pageHref) || state.phase !== "cooldown") return;
          state.cooldownTimer = 0;
          state.phase = "completed";
          const shouldRunPending = state.pendingActivation;
          state.pendingActivation = false;
          if (shouldRunPending && findTarget(profile.trigger?.target, { requireVisible: true })) {
            queueProfile(profile, "elementVisible");
          }
          scheduleAutoRun();
        }, Math.max(0, Number(options.cooldownMs) || 0));
      }
      emitRuntimeEvent("run.succeeded", { profileId: profile.id, runId: runContext.runId, durationMs: Date.now() - startedAt });
      return { ok: true, message: "流程已执行完成", reason };
    } catch (error) {
      if (error?.name === "AbortError") {
        state.phase = "cancelled";
        state.lastMessage = "流程已取消";
        emitRuntimeEvent("run.cancelled", { level: "warn", code: "RUN_CANCELLED", profileId: profile.id, runId: runContext.runId, durationMs: Date.now() - startedAt });
        return { ok: false, cancelled: true, message: "流程已取消", reason };
      }
      state.phase = "failed";
      state.lastMessage = error?.message || "流程执行失败";
      emitRuntimeEvent("run.failed", { level: "error", code: error?.code || "ACTION_FAILED", profileId: profile.id, runId: runContext.runId, durationMs: Date.now() - startedAt });
      return { ok: false, code: error?.code || "ACTION_FAILED", message: state.lastMessage };
    } finally {
      await releaseRun(runContext.runId);
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
        const { profile, state, manual, generation, runId, revision, documentId } = item;
        if (generation !== runtimeGeneration || ruleStates.get(profile.id) !== state) {
          state.phase = "cancelled";
          state.queued = false;
          await releaseRun(runId);
          item.resolve?.({ ok: false, cancelled: true, message: "流程已取消" });
          continue;
        }
        if (!globalEnabled || (!manual && !profile.enabled) || !matchesProfile(profile, location.href)) {
          state.phase = "armed";
          state.queued = false;
          await releaseRun(runId);
          item.resolve?.({ ok: false, skipped: true, message: "规则未启用或不匹配当前页面" });
          continue;
        }
        const result = await executeProfile(profile, state, item.reason, generation, {
          runId,
          revision,
          documentId,
          profileId: profile.id
        });
        item.resolve?.(result);
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
      queueProfile(profile, "elementVisible").then((queued) => {
        if (!queued && state.phase === "cooldown") state.pendingActivation = true;
      }).catch(() => undefined);
    }
  }

  const TRIGGER_HANDLERS = Object.freeze({
    pageLoad: {
      onScan: ({ profile, state }) => {
        if (deferredPageLoadIds.has(profile.id)) return;
        if (state.runCount === 0) queueProfile(profile, "pageLoad").catch(() => undefined);
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
      deferPageLoadUntilNavigation = false;
      resetRuntimeStates();
      runtimeSnapshot = null;
      profiles = [];
      globalEnabled = false;
      requestSnapshot().catch((error) => emitRuntimeEvent("runtime.navigation.failed", { level: "error", code: error.code || "SNAPSHOT_FAILED" }));
      return;
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
    scanDirty = true;
    scanTimer = window.setTimeout(runScheduledScan, 120);
    if (!scanMaxTimer) scanMaxTimer = window.setTimeout(runScheduledScan, 1000);
  }

  function runScheduledScan() {
    window.clearTimeout(scanTimer);
    window.clearTimeout(scanMaxTimer);
    scanTimer = 0;
    scanMaxTimer = 0;
    if (!scanDirty) return;
    scanDirty = false;
    evaluateRules();
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
    if (!globalEnabled || !event.isTrusted || pickerCleanup) return;
    for (const profile of matchingProfiles()) {
      const handler = TRIGGER_HANDLERS[profile.trigger?.type];
      if (handler?.matchesEvent?.({ event, profile })) queueProfile(profile, "userClick").catch(() => undefined);
    }
  }

  function resetForNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    deferPageLoadUntilNavigation = false;
    resetRuntimeStates();
    runtimeSnapshot = null;
    profiles = [];
    globalEnabled = false;
    requestSnapshot().catch((error) => emitRuntimeEvent("runtime.navigation.failed", { level: "error", code: error.code || "SNAPSHOT_FAILED" }));
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
    navigationTimer = window.setInterval(resetForNavigation, 500);
  }

  async function applyProfile(profileId, force = false) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return { ok: false, message: "当前页面没有找到这条规则", code: "URL_MISMATCH" };
    const normalized = normalizeProfile(profile);
    if (!isSupportedProfile(normalized)) return { ok: false, message: "规则包含当前版本不支持的动作或数据版本" };
    if (!force && (!normalized.enabled || !globalEnabled || !matchesProfile(normalized, location.href))) {
      return { ok: false, skipped: true, message: "规则未启用或不匹配当前页面" };
    }
    const state = ruleState(normalized);
    if (!force) {
      queueProfile(normalized, "automatic").catch(() => undefined);
      return { ok: true, queued: true, message: "规则已加入执行队列" };
    }
    if (!globalEnabled) return { ok: false, message: "总开关已关闭，无法测试规则" };
    if (!matchesProfile(normalized, location.href)) return { ok: false, message: "规则与当前页面不匹配，无法测试" };
    const queued = await queueProfile(normalized, "manual", { manual: true, resetCount: true, waitForResult: true });
    if (!queued) {
      return { ok: false, message: state.phase === "running" ? "规则正在执行" : "规则暂时无法加入执行队列" };
    }
    return queued.promise;
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
      text: ["input", "textarea", "select"].includes(tag) ? "" : cleanText(element.innerText).slice(0, 80),
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
    try {
      await requestSnapshot();
      emitRuntimeEvent("runtime.session.started");
    } catch (error) {
      profiles = [];
      globalEnabled = false;
      emitRuntimeEvent("runtime.session.failed", { level: "error", code: error.code || "SNAPSHOT_FAILED" });
    }
  }

  async function handleSnapshotUpdated(revision) {
    emitRuntimeEvent("runtime.settings.changed", { context: { revision } });
    resetRuntimeStates();
    runtimeSnapshot = null;
    profiles = [];
    globalEnabled = false;
    try {
      await requestSnapshot({ deferPageLoad: true });
    } catch (error) {
      emitRuntimeEvent("runtime.snapshot.failed", { level: "error", code: error.code || "SNAPSHOT_FAILED" });
    }
  }

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
    if (message?.type === "runtime.requestManualRun") {
      const expectedRevision = Number(message.payload?.expectedRevision);
      const prepare = !runtimeSnapshot || (Number.isFinite(expectedRevision) && runtimeSnapshot.revision !== expectedRevision)
        ? requestSnapshot({ deferPageLoad: true })
        : Promise.resolve();
      prepare.then(() => {
        if (Number.isFinite(expectedRevision) && runtimeSnapshot?.revision !== expectedRevision) {
          const error = new Error("页面规则版本已变化，请重新打开面板后重试");
          error.code = "REVISION_STALE";
          throw error;
        }
        return applyProfile(message.payload?.profileId, true);
      })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, code: error.code || "MANUAL_RUN_FAILED", message: error.message }));
      return true;
    }
    if (message?.type === "runtime.snapshotUpdated") {
      handleSnapshotUpdated(message.payload?.revision).catch(() => undefined);
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
  window.addEventListener("pageshow", () => {
    lastUrl = location.href;
    resetRuntimeStates({ clearDeferred: !deferPageLoadUntilNavigation });
    scheduleAutoRun();
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleAutoRun();
  }, true);
  document.addEventListener("click", handleUserClick, true);
  patchHistoryNavigation();
  loadSettings();
})();
