(() => {
  const deepClone = (value) => JSON.parse(JSON.stringify(value));
  const CURRENT_SCHEMA_VERSION = 3;
  const PROTOCOL_VERSION = 1;
  const UNSUPPORTED_ACTION = "__unsupported__";
  const SUPPORTED_ACTIONS = Object.freeze(["fill", "check", "click", "select", "wait", "delay"]);
  const VALUE_BEARING_ACTIONS = Object.freeze(["fill", "select"]);
  const RUNTIME_EVENT_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
  const RUNTIME_EVENT_NAMES = Object.freeze([
    "locator.ambiguous",
    "locator.not_found",
    "locator.resolved",
    "run.cancelled",
    "run.failed",
    "run.started",
    "run.succeeded",
    "runtime.navigation.failed",
    "runtime.session.failed",
    "runtime.session.snapshot",
    "runtime.session.started",
    "runtime.settings.changed",
    "runtime.snapshot.failed",
    "runtime.state.reset",
    "scheduler.queued",
    "scheduler.skipped",
    "step.failed",
    "step.started",
    "step.succeeded"
  ]);
  const RUNTIME_EVENT_CODES = Object.freeze([
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "ACTION_UNSUPPORTED",
    "ACTION_FAILED",
    "RUN_CANCELLED",
    "RUN_STALE",
    "RUN_TIMEOUT",
    "PROFILE_DISABLED",
    "GLOBAL_DISABLED",
    "URL_MISMATCH",
    "REVISION_STALE",
    "PERMISSION_DENIED",
    "UNSUPPORTED_FRAME",
    "PROTOCOL_INVALID",
    "SNAPSHOT_FAILED",
    "RUN_AUTHORIZATION_FAILED",
    "STEP_VALUE_FAILED",
    "MANUAL_RUN_FAILED",
    "CONFIG_WRITE_FAILED",
    "LOG_WRITE_FAILED",
    "GRANT_INVALID",
    "GRANT_EXPIRED"
  ]);
  const TARGET_KEYS = Object.freeze(["tag", "id", "name", "placeholder", "ariaLabel", "role", "type", "text", "css"]);

  const DEFAULT_ATRUST_PROFILE = {
    id: "atrust-login",
    name: "aTrust 登录",
    enabled: false,
    site: {
      origin: "https://atrust.inforbus.com",
      pathPrefix: "/portal/",
      hashPrefix: "#/login"
    },
    steps: [
      {
        id: "atrust-username",
        label: "用户名",
        action: "fill",
        secret: false,
        value: "",
        target: { tag: "input", placeholder: "请输入账号" }
      },
      {
        id: "atrust-password",
        label: "密码",
        action: "fill",
        secret: true,
        value: "",
        target: { tag: "input", id: "password" }
      },
      {
        id: "atrust-agreement",
        label: "用户协议",
        action: "check",
        secret: false,
        value: true,
        target: { tag: "input", css: ".privacy-wrapper input[type=checkbox]" }
      },
      {
        id: "atrust-submit",
        label: "登录",
        action: "click",
        secret: false,
        value: "",
        target: { tag: "button", text: "登录", css: ".portal-login-button button[type=submit]" }
      }
    ]
  };

  function createId(prefix = "rule") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function normalizeOrigin(value) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 http 或 https 网站");
    return `${url.protocol}//${url.host}`;
  }

  function siteFromUrl(value) {
    const url = new URL(value);
    return {
      origin: `${url.protocol}//${url.host}`,
      pathPrefix: url.pathname === "/" ? "" : url.pathname,
      hashPrefix: url.hash || ""
    };
  }

  function isValueBearingTarget(target = {}) {
    const tag = String(target.tag || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  }

  function normalizeTarget(rawTarget) {
    const source = rawTarget && typeof rawTarget === "object" ? rawTarget : {};
    const target = {};
    for (const key of TARGET_KEYS) {
      if (source[key] === undefined || source[key] === null) continue;
      if (key === "text" && isValueBearingTarget(source)) continue;
      target[key] = typeof source[key] === "string" ? source[key].trim() : source[key];
    }
    return target;
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(number, maximum));
  }

  function isValueBearingAction(action) {
    return VALUE_BEARING_ACTIONS.includes(action);
  }

  function runtimeProfile(profile) {
    const source = normalizeProfile(profile);
    const steps = source.steps.map((step) => ({
      id: step.id,
      label: step.label,
      action: step.action,
      secret: Boolean(step.secret),
      enabled: step.enabled !== false,
      timeoutMs: step.timeoutMs,
      target: normalizeTarget(step.target),
      ...(isValueBearingAction(step.action) ? { value: "", valueRequired: true } : { value: step.value ?? "" })
    }));
    return {
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      schemaVersion: source.schemaVersion,
      site: {
        origin: source.site.origin,
        pathPrefix: source.site.pathPrefix,
        hashPrefix: source.site.hashPrefix
      },
      trigger: {
        type: source.trigger.type,
        target: normalizeTarget(source.trigger.target),
        options: {
          oncePerPage: source.trigger.options.oncePerPage !== false,
          retriggerWhenReappears: Boolean(source.trigger.options.retriggerWhenReappears),
          cooldownMs: source.trigger.options.cooldownMs,
          timeoutMs: source.trigger.options.timeoutMs,
          maxRuns: source.trigger.options.maxRuns
        }
      },
      steps
    };
  }

  function pageUrlForDiagnostics(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function sanitizeRuntimeContext(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return {};
    const result = {};
    const stringEnums = {
      action: ["fill", "check", "click", "select", "wait", "delay"],
      reason: ["pageLoad", "elementVisible", "userClick", "automatic", "manual"],
      triggerType: ["pageLoad", "elementVisible", "userClick"],
      phase: ["armed", "authorizing", "queued", "running", "cooldown", "completed", "failed", "cancelled"]
    };
    const numericKeys = new Set(["matches", "profileCount", "attempt", "revision"]);
    for (const [key, value] of Object.entries(context)) {
      if (Object.hasOwn(stringEnums, key)) {
        if (typeof value === "string" && stringEnums[key].includes(value)) result[key] = value;
      } else if (numericKeys.has(key) && typeof value === "number" && Number.isFinite(value)) {
        result[key] = Math.max(0, Math.min(value, 100000));
      }
    }
    return result;
  }

  function sanitizeRuntimeEvent(event) {
    const source = event && typeof event === "object" ? event : {};
    const sanitized = {
      timestamp: Number.isFinite(Number(source.timestamp)) ? Number(source.timestamp) : Date.now(),
      seq: Number.isFinite(Number(source.seq)) ? Number(source.seq) : 0,
      level: RUNTIME_EVENT_LEVELS.includes(source.level) ? source.level : "info",
      event: RUNTIME_EVENT_NAMES.includes(source.event) ? source.event : "runtime.state.reset",
      code: RUNTIME_EVENT_CODES.includes(source.code) ? source.code : "",
      documentId: String(source.documentId || "").slice(0, 160),
      sessionId: String(source.sessionId || "").slice(0, 160),
      runId: String(source.runId || "").slice(0, 160),
      profileId: String(source.profileId || "").slice(0, 160),
      stepId: String(source.stepId || "").slice(0, 160),
      revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0,
      durationMs: Number.isFinite(Number(source.durationMs)) ? Math.max(0, Number(source.durationMs)) : undefined,
      page: pageUrlForDiagnostics(source.page || ""),
      context: sanitizeRuntimeContext(source.context)
    };
    if (sanitized.durationMs === undefined) delete sanitized.durationMs;
    return sanitized;
  }

  function normalizeProfile(profile) {
    const next = deepClone(profile || {});
    next.id = next.id || createId("profile");
    next.name = next.name || "未命名站点";
    next.enabled = Boolean(next.enabled);
    const sourceSchemaVersion = Number(next.schemaVersion);
    const markedUnsupportedVersion = Number(next.unsupportedSchemaVersion);
    next.unsupportedSchemaVersion = Number.isFinite(markedUnsupportedVersion) && markedUnsupportedVersion > CURRENT_SCHEMA_VERSION
      ? markedUnsupportedVersion
      : Number.isFinite(sourceSchemaVersion) && sourceSchemaVersion > CURRENT_SCHEMA_VERSION
        ? sourceSchemaVersion
        : 0;
    next.schemaVersion = CURRENT_SCHEMA_VERSION;
    next.site = next.site || { origin: "", pathPrefix: "", hashPrefix: "" };
    next.site.origin = next.site.origin || "";
    next.site.pathPrefix = next.site.pathPrefix || "";
    next.site.hashPrefix = next.site.hashPrefix || "";
    const incomingTrigger = next.trigger && typeof next.trigger === "object" ? next.trigger : {};
    const legacySubmitEnabled = Boolean(incomingTrigger.enabled);
    const legacySubmitTarget = normalizeTarget(incomingTrigger.target);
    const incomingTriggerType = ["pageLoad", "elementVisible", "userClick"].includes(incomingTrigger.type)
      ? incomingTrigger.type
      : "pageLoad";
    const isConditionTrigger = incomingTriggerType !== "pageLoad";
    const repeatMode = isConditionTrigger && (incomingTriggerType === "elementVisible"
      ? Boolean(incomingTrigger.options?.retriggerWhenReappears)
      : incomingTrigger.options?.oncePerPage === false);
    const oncePerPage = !repeatMode;
    next.trigger = {
      type: incomingTriggerType,
      target: normalizeTarget(incomingTrigger.target),
      options: {
        oncePerPage,
        retriggerWhenReappears: incomingTriggerType === "elementVisible" && repeatMode,
        cooldownMs: boundedNumber(incomingTrigger.options?.cooldownMs, 1500, 0, 30000),
        timeoutMs: boundedNumber(incomingTrigger.options?.timeoutMs, 30000, 1000, 120000),
        maxRuns: repeatMode ? 50 : 1
      }
    };
    if (!Array.isArray(next.steps)) {
      const legacySteps = Array.isArray(next.fields) ? next.fields : [];
      next.steps = legacySteps.map((field) => ({ ...field }));
      if (legacySubmitEnabled && Object.keys(legacySubmitTarget).length) {
        next.steps.push({
          id: createId("step"),
          label: "提交",
          action: "click",
          secret: false,
          value: "",
          enabled: true,
          target: legacySubmitTarget
        });
      }
    }
    next.steps = next.steps.map((field) => {
      const rawAction = field?.action;
      const hasExplicitAction = rawAction !== undefined && rawAction !== null && rawAction !== "";
      const action = !hasExplicitAction
        ? "fill"
        : SUPPORTED_ACTIONS.includes(rawAction)
          ? rawAction
          : UNSUPPORTED_ACTION;
      const step = {
        id: field.id || createId("field"),
        label: field.label || "步骤",
        action,
        secret: Boolean(field.secret),
        value: field.value ?? field.actionValue ?? "",
        enabled: field.enabled !== false && action !== UNSUPPORTED_ACTION,
        timeoutMs: boundedNumber(field.timeoutMs, 12000, 1000, 120000),
        target: normalizeTarget(field.target)
      };
      if (action === UNSUPPORTED_ACTION) step.unsupportedAction = String(rawAction);
      return step;
    });
    return next;
  }

  function isSupportedProfile(profile) {
    const normalized = profile && profile.schemaVersion === CURRENT_SCHEMA_VERSION ? profile : normalizeProfile(profile);
    return normalized.unsupportedSchemaVersion === 0
      && Array.isArray(normalized.steps)
      && normalized.steps.every((step) => SUPPORTED_ACTIONS.includes(step.action));
  }

  function exportProfileData(profile, includeSecrets = false) {
    const source = normalizeProfile(profile);
    const exported = {
      id: source.id,
      name: source.name,
      enabled: Boolean(source.enabled),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      site: {
        origin: source.site.origin,
        pathPrefix: source.site.pathPrefix,
        hashPrefix: source.site.hashPrefix
      },
      trigger: {
        type: source.trigger.type,
        target: normalizeTarget(source.trigger.target),
        options: {
          oncePerPage: source.trigger.options.oncePerPage !== false,
          retriggerWhenReappears: Boolean(source.trigger.options.retriggerWhenReappears),
          cooldownMs: boundedNumber(source.trigger.options.cooldownMs, 1500, 0, 30000),
          timeoutMs: boundedNumber(source.trigger.options.timeoutMs, 30000, 1000, 120000),
          maxRuns: boundedNumber(source.trigger.options.maxRuns, 1, 1, 50)
        }
      },
      steps: source.steps.map((step) => {
        const exportedStep = {
          id: step.id,
          label: step.label,
          action: step.action,
          secret: Boolean(step.secret),
          enabled: step.enabled !== false,
          timeoutMs: boundedNumber(step.timeoutMs, 12000, 1000, 120000),
          target: normalizeTarget(step.target)
        };
        if (includeSecrets) exportedStep.value = step.value ?? "";
        else if (!step.secret && step.action !== "fill") exportedStep.actionValue = step.value ?? "";
        return exportedStep;
      })
    };
    if (source.unsupportedSchemaVersion > 0) exported.unsupportedSchemaVersion = source.unsupportedSchemaVersion;
    return exported;
  }

  function matchesProfile(profile, href) {
    try {
      const url = new URL(href);
      const site = profile.site || {};
      if (site.origin && `${url.protocol}//${url.host}` !== site.origin) return false;
      if (site.pathPrefix && !url.pathname.startsWith(site.pathPrefix)) return false;
      if (site.hashPrefix && !url.hash.startsWith(site.hashPrefix)) return false;
      return Boolean(site.origin);
    } catch {
      return false;
    }
  }

  function targetSummary(target = {}) {
    if (target.id) return `#${target.id}`;
    if (target.name) return `[name=${target.name}]`;
    if (target.placeholder) return `占位符：${target.placeholder}`;
    if (target.ariaLabel) return `aria：${target.ariaLabel}`;
    if (target.text) return `文本：${target.text}`;
    if (target.css) return target.css;
    return "未选择元素";
  }

  function copyProfile(profile) {
    return deepClone(normalizeProfile(profile));
  }

  globalThis.AutoFillShared = {
    DEFAULT_ATRUST_PROFILE,
    PROTOCOL_VERSION,
    RUNTIME_EVENT_CODES,
    RUNTIME_EVENT_LEVELS,
    RUNTIME_EVENT_NAMES,
    VALUE_BEARING_ACTIONS,
    copyProfile,
    createId,
    deepClone,
    exportProfileData,
    isSupportedProfile,
    isValueBearingAction,
    isValueBearingTarget,
    matchesProfile,
    boundedNumber,
    normalizeOrigin,
    normalizeProfile,
    normalizeTarget,
    pageUrlForDiagnostics,
    runtimeProfile,
    sanitizeRuntimeEvent,
    SUPPORTED_ACTIONS,
    UNSUPPORTED_ACTION,
    siteFromUrl,
    targetSummary
  };
})();
