(() => {
  const deepClone = (value) => JSON.parse(JSON.stringify(value));

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

  function normalizeProfile(profile) {
    const next = deepClone(profile || {});
    next.id = next.id || createId("profile");
    next.name = next.name || "未命名站点";
    next.enabled = Boolean(next.enabled);
    next.schemaVersion = Math.max(3, Number(next.schemaVersion) || 0);
    next.site = next.site || { origin: "", pathPrefix: "", hashPrefix: "" };
    next.site.origin = next.site.origin || "";
    next.site.pathPrefix = next.site.pathPrefix || "";
    next.site.hashPrefix = next.site.hashPrefix || "";
    const incomingTrigger = next.trigger || {};
    const incomingTriggerType = ["pageLoad", "elementVisible", "userClick"].includes(incomingTrigger.type)
      ? incomingTrigger.type
      : "pageLoad";
    const oncePerPage = incomingTrigger.options?.oncePerPage !== false;
    next.trigger = {
      type: incomingTriggerType,
      target: incomingTrigger.target || {},
      options: {
        oncePerPage,
        retriggerWhenReappears: Boolean(incomingTrigger.options?.retriggerWhenReappears),
        cooldownMs: Math.max(0, Math.min(Number(incomingTrigger.options?.cooldownMs) || 1500, 30000)),
        timeoutMs: Math.max(1000, Math.min(Number(incomingTrigger.options?.timeoutMs) || 30000, 120000)),
        maxRuns: Math.max(1, Math.min(Number(incomingTrigger.options?.maxRuns) || (oncePerPage ? 1 : 50), 50))
      }
    };
    if (!Array.isArray(next.steps)) {
      const legacySteps = Array.isArray(next.fields) ? next.fields : [];
      next.steps = legacySteps.map((field) => ({ ...field }));
      if (next.trigger?.enabled && next.trigger.target) {
        next.steps.push({
          id: createId("step"),
          label: "提交",
          action: "click",
          secret: false,
          value: "",
          enabled: true,
          target: next.trigger.target
        });
      }
    }
    next.steps = next.steps.map((field) => ({
      id: field.id || createId("field"),
      label: field.label || "步骤",
      action: ["fill", "check", "click", "select", "wait", "delay"].includes(field.action) ? field.action : "fill",
      secret: Boolean(field.secret),
      value: field.value ?? "",
      enabled: field.enabled !== false,
      timeoutMs: Number.isFinite(Number(field.timeoutMs)) ? Number(field.timeoutMs) : 12000,
      target: field.target || {}
    }));
    return next;
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
    copyProfile,
    createId,
    deepClone,
    matchesProfile,
    normalizeOrigin,
    normalizeProfile,
    siteFromUrl,
    targetSummary
  };
})();
