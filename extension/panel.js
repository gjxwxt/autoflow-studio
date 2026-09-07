(() => {
  const {
    DEFAULT_ATRUST_PROFILE,
    copyProfile,
    createId,
    normalizeOrigin,
    normalizeProfile,
    siteFromUrl,
    targetSummary
  } = AutoFillShared;

  const ACTION_LABELS = Object.freeze({
    fill: "填充",
    check: "勾选",
    select: "选择",
    click: "点击",
    wait: "等待出现",
    delay: "等待时间"
  });
  const state = {
    profiles: [],
    activeId: "",
    view: "overview",
    editorMode: "edit",
    editorDraft: null,
    editorDirty: false,
    currentTab: null,
    picker: null,
    globalEnabled: true,
    collapsedStepsByProfile: new Map(),
    expandedGroups: new Set(),
    exportDraft: null,
    importMode: "file",
    tabRefreshTimer: null,
    permissionGranted: null,
    statusMessage: "",
    statusError: false
  };
  const $ = (selector) => document.querySelector(selector);
  const profileOverview = $("#profileOverview");
  const profileList = $("#profileList");
  const editor = $("#editor");
  const stepList = $("#stepList");
  const emptySteps = $("#emptySteps");
  const status = $("#status");
  const overviewStatus = $("#overviewStatus");

  function setStatus(message, isError = false) {
    state.statusMessage = message;
    state.statusError = isError;
    renderStatus();
  }

  function renderStatus() {
    for (const element of [status, overviewStatus]) {
      if (!element) continue;
      const visible = element === status ? state.view === "editor" : state.view === "overview";
      element.textContent = visible ? state.statusMessage : "";
      element.classList.toggle("error", visible && state.statusError);
    }
  }

  function markEditorDirty() {
    if (state.view === "editor") state.editorDirty = true;
  }

  function activeProfile() {
    return state.editorDraft || state.profiles.find((profile) => profile.id === state.activeId) || null;
  }

  function profileGroupKey(profile) {
    return profile?.site?.origin || "未设置网站";
  }

  function openEditor(profileId, mode = "edit") {
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    state.activeId = profile.id;
    state.view = "editor";
    state.editorMode = mode;
    state.editorDraft = copyProfile(profile);
    state.editorDirty = false;
    state.expandedGroups.add(profileGroupKey(profile));
    state.statusMessage = "";
    state.statusError = false;
    render();
  }

  function resetEditorState() {
    state.activeId = "";
    state.view = "overview";
    state.editorMode = "edit";
    state.editorDraft = null;
    state.editorDirty = false;
    state.statusMessage = "";
    state.statusError = false;
  }

  function commitEditorProfile(profile, isNew = state.editorMode === "new") {
    const saved = copyProfile(profile);
    if (isNew) {
      state.profiles = [saved, ...state.profiles];
    } else {
      state.profiles = state.profiles.map((item) => item.id === saved.id ? saved : item);
    }
    return saved;
  }

  function goToOverview() {
    if (state.view !== "editor") return;
    if (state.editorDirty && !window.confirm("当前规则有未保存的修改，确定放弃吗？")) return;
    if (state.picker) {
      state.picker = null;
      sendToCurrentTab({ type: "cancelPicker" }).catch(() => undefined);
    }

    resetEditorState();
    render();
  }

  function collapsedStepsFor(profile) {
    let collapsed = state.collapsedStepsByProfile.get(profile.id);
    if (!collapsed) {
      collapsed = new Set(profile.steps.length > 2 ? profile.steps.map((step) => step.id) : []);
      state.collapsedStepsByProfile.set(profile.id, collapsed);
    }
    return collapsed;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function makeIconButton(icon, title, className = "") {
    const paths = {
      download: "M12 3v11m0 0 4-4m-4 4-4-4M4 18.5V21h16v-2.5",
      upload: "M12 21V10m0 0 4 4m-4-4-4 4M4 5.5V3h16v2.5"
    };
    const button = makeElement("button", `icon-button${className ? ` ${className}` : ""}`);
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ui-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[icon]);
    svg.append(path);
    button.append(svg);
    return button;
  }

  function profileScope(profile) {
    const path = profile.site.pathPrefix || "";
    const hash = profile.site.hashPrefix || "";
    return path || hash ? `${path}${hash}` : "全站";
  }

  function suggestedProfileName(site, title = "") {
    const cleanTitle = String(title || "").trim();
    if (cleanTitle && !["读取中", "未读取页面"].includes(cleanTitle)) return cleanTitle.slice(0, 80);
    if (!site.origin) return "新站点规则";
    const host = new URL(site.origin).hostname;
    const scope = `${site.pathPrefix || ""}${site.hashPrefix || ""}` || "首页";
    return `${host} · ${scope}`;
  }

  function safeFilename(value) {
    return String(value || "autoflow-studio").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "autoflow-studio";
  }

  function exportProfile(profile, includeSecrets) {
    const exported = copyProfile(profile);
    if (!includeSecrets) {
      exported.steps.forEach((step) => {
        if (step.secret || step.action === "fill") step.value = "";
      });
    }
    return exported;
  }

  function makeExportPayload(kind, profiles, includeSecrets) {
    return {
      format: "autofill-studio",
      formatVersion: 1,
      kind,
      exportedAt: new Date().toISOString(),
      globalEnabled: state.globalEnabled,
      activeProfileId: kind === "backup" ? state.activeId : "",
      secretsIncluded: includeSecrets,
      profiles: profiles.map((profile) => exportProfile(profile, includeSecrets))
    };
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  function renderExportOptions() {
    const draft = state.exportDraft;
    if (!draft) return;
    const list = $("#exportProfileOptions");
    list.replaceChildren();
    for (const profile of draft.profiles) {
      const option = makeElement("label", "export-profile-option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = draft.selectedIds.has(profile.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) draft.selectedIds.add(profile.id);
        else draft.selectedIds.delete(profile.id);
        $("#exportSelectionCount").textContent = `${draft.selectedIds.size}/${draft.profiles.length}`;
      });
      const info = makeElement("span", "export-profile-info");
      info.append(
        makeElement("strong", "export-profile-name", profile.name),
        makeElement("span", "export-profile-scope", `${profile.site.pathPrefix || "全站"}${profile.site.hashPrefix || ""}`)
      );
      option.append(checkbox, info);
      list.append(option);
    }
    $("#exportSelectionCount").textContent = `${draft.selectedIds.size}/${draft.profiles.length}`;
  }

  function setExportMode(mode) {
    if (!state.exportDraft) return;
    state.exportDraft.mode = mode;
    document.querySelectorAll("[data-export-mode]").forEach((tab) => {
      const active = tab.dataset.exportMode === mode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    $("#confirmExport").textContent = mode === "clipboard" ? "复制到剪贴板" : "导出文件";
  }

  function openExportDialog(profiles, label, kind) {
    if (!profiles.length) return;
    state.exportDraft = {
      profiles,
      label,
      kind,
      mode: "file",
      selectedIds: new Set(profiles.map((profile) => profile.id))
    };
    const isBackup = kind === "backup";
    $("#exportDialogTitle").textContent = isBackup ? "导出全部数据" : profiles.length === 1 ? "导出页面规则" : "导出域名规则";
    $("#exportDialogSubtitle").textContent = label;
    $("#exportSecurityNote").textContent = isBackup
      ? "完整备份包含账号密码；导入时会覆盖当前全部数据。"
      : "规则分享不包含账号密码；导入同规则时保留本地已有值。";
    renderExportOptions();
    setExportMode("file");
    $("#exportDialog").showModal();
  }

  async function executeExport() {
    const draft = state.exportDraft;
    if (!draft) return;
    const profiles = draft.profiles.filter((profile) => draft.selectedIds.has(profile.id));
    if (!profiles.length) {
      setStatus("至少选择一条规则。", true);
      return;
    }
    const includeSecrets = draft.kind === "backup";
    if (includeSecrets && !window.confirm("这份导出会包含用户名和密码，请确认目标位置或剪贴板安全。继续吗？")) return;
    const payload = makeExportPayload(draft.kind, profiles, includeSecrets);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (draft.mode === "clipboard") {
      const copied = await copyText(JSON.stringify(payload, null, 2));
      if (!copied) throw new Error("无法写入剪贴板，请改用本地文件导出");
      setStatus(includeSecrets ? "完整数据已复制到剪贴板，请立即粘贴到安全位置。" : "规则 JSON 已复制到剪贴板。", false);
    } else {
      const filename = includeSecrets
        ? `autoflow-studio-完整备份-${stamp}.json`
        : `${safeFilename(draft.label)}-规则分享-${stamp}.json`;
      downloadJson(payload, filename);
      setStatus(includeSecrets ? "完整备份已导出，请妥善保管文件。" : "规则文件已导出，填充值已隐藏。", false);
    }
    $("#exportDialog").close();
    state.exportDraft = null;
  }

  function rekeyProfile(profile) {
    const imported = copyProfile(profile);
    imported.id = createId("profile");
    imported.steps = imported.steps.map((step) => ({ ...step, id: createId("step") }));
    return imported;
  }

  function profileMatchKey(profile) {
    const site = profile?.site || {};
    const trigger = profile?.trigger || {};
    const triggerTarget = trigger.target || {};
    if (!site.origin) return "";
    try {
      return JSON.stringify([
        normalizeOrigin(site.origin),
        String(site.pathPrefix || "").trim(),
        String(site.hashPrefix || "").trim(),
        trigger.type || "pageLoad",
        triggerTarget.id || "",
        triggerTarget.name || "",
        triggerTarget.placeholder || "",
        triggerTarget.ariaLabel || "",
        triggerTarget.css || "",
        triggerTarget.text || ""
      ]);
    } catch {
      return "";
    }
  }

  function hasMeaningfulValue(value) {
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function stepStructureKey(step) {
    const target = step?.target || {};
    return JSON.stringify([
      step?.action || "",
      step?.label || "",
      target.id || "",
      target.name || "",
      target.placeholder || "",
      target.ariaLabel || "",
      target.css || "",
      target.text || ""
    ]);
  }

  function findMergeStep(localSteps, incomingStep, usedIndexes) {
    let index = localSteps.findIndex((step, stepIndex) => !usedIndexes.has(stepIndex) && step.id && step.id === incomingStep.id);
    if (index >= 0) return index;
    const incomingKey = stepStructureKey(incomingStep);
    index = localSteps.findIndex((step, stepIndex) => !usedIndexes.has(stepIndex) && stepStructureKey(step) === incomingKey);
    if (index >= 0) return index;
    const label = String(incomingStep?.label || "");
    const labelMatches = localSteps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step, stepIndex }) => !usedIndexes.has(stepIndex) && step.action === incomingStep.action && String(step.label || "") === label);
    if (labelMatches.length === 1) return labelMatches[0].stepIndex;
    return -1;
  }

  function mergeImportedProfile(localProfile, incomingProfile) {
    const merged = copyProfile(incomingProfile);
    const localSteps = Array.isArray(localProfile.steps) ? localProfile.steps : [];
    const usedIndexes = new Set();
    let valueConflicts = 0;

    merged.id = localProfile.id;
    merged.name = localProfile.name || merged.name;
    merged.enabled = localProfile.enabled;
    merged.steps = merged.steps.length
      ? merged.steps.map((incomingStep) => {
          const localIndex = findMergeStep(localSteps, incomingStep, usedIndexes);
          if (localIndex < 0) return incomingStep;
          usedIndexes.add(localIndex);
          const localStep = localSteps[localIndex];
          const next = { ...incomingStep, id: localStep.id || incomingStep.id };
          const localHasValue = hasMeaningfulValue(localStep.value);
          const incomingHasValue = hasMeaningfulValue(incomingStep.value);
          if (localHasValue && incomingHasValue && JSON.stringify(localStep.value) !== JSON.stringify(incomingStep.value)) valueConflicts += 1;
          next.value = localHasValue ? localStep.value : incomingStep.value;
          next.enabled = localStep.enabled !== false;
          next.secret = Boolean(localStep.secret || incomingStep.secret);
          return next;
        })
      : localSteps.map((step) => ({ ...step }));

    return { profile: merged, valueConflicts };
  }

  function mergeSharedProfiles(incomingProfiles, existingProfiles) {
    const nextProfiles = existingProfiles.map(copyProfile);
    const report = { added: 0, merged: 0, valueConflicts: 0 };
    for (const incomingProfile of incomingProfiles) {
      const key = profileMatchKey(incomingProfile);
      const existingIndex = key
        ? nextProfiles.findIndex((profile) => profileMatchKey(profile) === key)
        : -1;
      if (existingIndex < 0) {
        nextProfiles.unshift(rekeyProfile(incomingProfile));
        report.added += 1;
        continue;
      }
      const result = mergeImportedProfile(nextProfiles[existingIndex], incomingProfile);
      nextProfiles[existingIndex] = result.profile;
      report.merged += 1;
      report.valueConflicts += result.valueConflicts;
    }
    return { profiles: nextProfiles, report };
  }

  async function persistState() {
    await chrome.storage.local.set({
      schemaVersion: 3,
      profiles: state.profiles,
      activeProfileId: state.activeId,
      globalEnabled: state.globalEnabled
    });
    await chrome.runtime.sendMessage({ type: "syncContentScripts" }).catch(() => undefined);
  }

  function setImportMode(mode) {
    state.importMode = mode;
    document.querySelectorAll("[data-import-mode]").forEach((tab) => {
      const active = tab.dataset.importMode === mode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    $("#importFilePane").hidden = mode !== "file";
    $("#importClipboardPane").hidden = mode !== "clipboard";
  }

  function openImportDialog() {
    $("#importClipboardText").value = "";
    setImportMode("file");
    $("#importDialog").showModal();
  }

  async function importFromText(rawText) {
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error("文件不是有效的 JSON 备份");
    }
    if (payload?.format !== "autofill-studio" || !Array.isArray(payload.profiles)) {
      throw new Error("不是 AutoFlow Studio 的规则或备份文件");
    }
    if (payload.profiles.length > 200) throw new Error("文件中的规则数量过多");
    const incoming = payload.profiles.map(normalizeProfile);
    let shareReport = null;
    if (payload.kind === "backup") {
      const passwordNote = payload.secretsIncluded ? "其中可能包含密码。" : "密码字段为空。";
      if (!window.confirm(`导入完整备份将覆盖当前全部规则，${passwordNote}确定继续吗？`)) return false;
      state.profiles = incoming;
      state.globalEnabled = payload.globalEnabled !== false;
    } else {
      if (!incoming.length) throw new Error("分享文件中没有可导入的规则");
      const result = mergeSharedProfiles(incoming, state.profiles);
      const summary = `将新增 ${result.report.added} 条、合并 ${result.report.merged} 条页面规则。重复规则合并时保留本地已有值，有值冲突时以本地为准。`;
      if (!window.confirm(summary + "\n\n确定继续吗？")) return false;
      state.profiles = result.profiles;
      shareReport = result.report;
    }
    state.collapsedStepsByProfile.clear();
    state.expandedGroups.clear();
    resetEditorState();
    await persistState();
    render();
    if (payload.kind === "backup") {
      setStatus("完整备份已导入。首次使用各域名时可能需要重新授权。", false);
    } else {
      const report = shareReport || { added: incoming.length, merged: 0, valueConflicts: 0 };
      const conflictNote = report.valueConflicts ? `，${report.valueConflicts} 个值冲突按本地保留` : "";
      setStatus(`规则已导入：新增 ${report.added} 条，合并 ${report.merged} 条${conflictNote}。`, false);
    }
    return true;
  }

  async function importFromFile(file) {
    return importFromText(await file.text());
  }

  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    state.currentTab = tab || null;
    $("#currentTitle").textContent = tab?.title || "未读取页面";
    $("#currentUrl").textContent = tab?.url || "当前页面不可访问";
    await updatePermissionState(tab?.url || "");
    return tab;
  }

  function scheduleTabRefresh() {
    window.clearTimeout(state.tabRefreshTimer);
    state.tabRefreshTimer = window.setTimeout(() => {
      getCurrentTab().catch(() => undefined);
    }, 80);
  }

  async function updatePermissionState(url) {
    const badge = $("#permissionState");
    badge.className = "permission-badge";
    if (!url || !/^https?:/.test(url)) {
      state.permissionGranted = false;
      badge.textContent = "不可配置";
      badge.classList.add("warn");
      updateQuickCreateButton(url);
      return;
    }
    try {
      const origin = normalizeOrigin(url);
      const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      state.permissionGranted = allowed;
      badge.textContent = allowed ? "已授权" : "待授权";
      badge.classList.add(allowed ? "ok" : "warn");
      updateQuickCreateButton(url);
    } catch {
      state.permissionGranted = false;
      badge.textContent = "待授权";
      badge.classList.add("warn");
      updateQuickCreateButton(url);
    }
  }

  function updateQuickCreateButton(url = state.currentTab?.url || "") {
    const button = $("#quickNewProfile");
    if (!button) return;
    button.hidden = !(state.view === "overview" && /^https?:/.test(url));
  }

  async function loadProfiles() {
    const stored = await chrome.storage.local.get({ profiles: [], activeProfileId: "", globalEnabled: true });
    state.globalEnabled = stored.globalEnabled !== false;
    $("#globalEnabled").checked = state.globalEnabled;
    state.profiles = Array.isArray(stored.profiles) && stored.profiles.length
      ? stored.profiles.map(normalizeProfile)
      : [copyProfile(DEFAULT_ATRUST_PROFILE)];
    state.activeId = "";
    state.view = "overview";
    state.editorDraft = null;
    state.editorDirty = false;
    render();
  }

  function renderProfiles() {
    profileList.replaceChildren();
    if (!state.profiles.length) {
      profileList.append(makeElement("div", "empty-state", "还没有站点规则，点击“新建”开始。"));
      return;
    }
    const groups = new Map();
    for (const profile of state.profiles) {
      const origin = profile.site.origin || "未设置网站";
      if (!groups.has(origin)) groups.set(origin, []);
      groups.get(origin).push(profile);
    }
    for (const [origin, profiles] of groups) {
      const group = makeElement("section", "profile-group");
      const groupHeader = makeElement("div", "profile-group-header");
      const expanded = state.expandedGroups.has(origin);
      const groupToggle = makeElement("button", "profile-group-toggle");
      groupToggle.type = "button";
      groupToggle.setAttribute("aria-expanded", String(expanded));
      groupToggle.setAttribute("aria-label", `${expanded ? "折叠" : "展开"} ${origin} 下的页面规则`);
      const groupInfo = makeElement("div", "profile-group-info");
      groupInfo.append(
        makeElement("span", "profile-group-origin mono", origin),
        makeElement("span", "profile-group-count", `${profiles.length} 个页面`)
      );
      groupToggle.append(makeElement("span", "profile-group-chevron", expanded ? "⌄" : "›"), groupInfo);
      groupToggle.addEventListener("click", () => {
        if (state.expandedGroups.has(origin)) state.expandedGroups.delete(origin);
        else state.expandedGroups.add(origin);
        renderProfiles();
      });
      const groupShare = makeIconButton("download", `下载 ${origin} 下的全部页面规则`, "profile-share");
      groupShare.addEventListener("click", () => openExportDialog(profiles, origin, "site"));
      const allEnabled = profiles.every((profile) => profile.enabled);
      const someEnabled = profiles.some((profile) => profile.enabled);
      const groupSwitch = makeElement("label", "switch group-switch");
      groupSwitch.title = `${allEnabled ? "停用" : "启用"} ${origin} 下的全部规则`;
      const groupSwitchInput = document.createElement("input");
      groupSwitchInput.type = "checkbox";
      groupSwitchInput.checked = allEnabled;
      groupSwitchInput.indeterminate = someEnabled && !allEnabled;
      groupSwitchInput.setAttribute("aria-label", groupSwitch.title);
      groupSwitchInput.addEventListener("change", () => setGroupEnabled(origin, profiles, groupSwitchInput.checked));
      groupSwitch.append(groupSwitchInput, makeElement("span", "slider"));
      groupHeader.append(groupToggle, groupShare, groupSwitch);
      const groupRules = makeElement("div", "profile-group-rules");
      groupRules.hidden = !expanded;
      for (const profile of profiles) {
        const item = makeElement("div", `profile-item${profile.id === state.activeId ? " active" : ""}`);
        const select = makeElement("button", "profile-select");
        select.type = "button";
        const info = makeElement("span", "profile-info");
        info.append(
          makeElement("span", "profile-name", profile.name),
          makeElement("span", "profile-meta", `${profileScope(profile)} · ${profile.steps.length} 个步骤`)
        );
        select.append(info);
        select.addEventListener("click", () => openEditor(profile.id));
        const statusDot = makeElement("span", `profile-status ${profile.enabled ? "enabled" : "disabled"}`);
        statusDot.title = profile.enabled ? "规则已启用" : "规则未启用";
        statusDot.setAttribute("role", "img");
        statusDot.setAttribute("aria-label", statusDot.title);
        item.append(select, statusDot);
        groupRules.append(item);
      }
      group.append(groupHeader, groupRules);
      profileList.append(group);
    }
  }

  async function setGroupEnabled(origin, profiles, enabled) {
    const previous = profiles.map((profile) => profile.enabled);
    profiles.forEach((profile) => { profile.enabled = enabled; });
    renderProfiles();
    try {
      await persistState();
      setStatus(`${origin} 下的 ${profiles.length} 条规则已${enabled ? "启用" : "停用"}。`, false);
    } catch (error) {
      profiles.forEach((profile, index) => { profile.enabled = previous[index]; });
      renderProfiles();
      setStatus(error.message || "保存域名开关状态失败。", true);
    }
  }

  function makeStepRow(step, index, profile) {
    const row = makeElement("div", "rule-row");
    const collapsedSteps = collapsedStepsFor(profile);
    const collapsed = collapsedSteps.has(step.id);
    const head = makeElement("div", "rule-row-head");
    const toggle = makeElement("button", "rule-toggle");
    toggle.append(makeElement("span", `rule-chevron ${collapsed ? "collapsed" : "expanded"}`, collapsed ? "›" : "⌄"));
    toggle.type = "button";
    toggle.title = collapsed ? "展开步骤详情" : "折叠步骤详情";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.addEventListener("click", () => {
      if (collapsedSteps.has(step.id)) collapsedSteps.delete(step.id);
      else collapsedSteps.add(step.id);
      renderEditor();
    });
    head.append(toggle);
    head.append(makeElement("span", "rule-order", String(index + 1)));
    const label = document.createElement("input");
    label.className = "rule-label";
    label.value = step.label;
    label.placeholder = "步骤名称";
    label.addEventListener("input", () => { step.label = label.value; markEditorDirty(); });
    head.append(label);
    head.append(makeElement("span", "step-action-chip", ACTION_LABELS[step.action] || step.action));
    const remove = makeElement("button", "remove-button", "×");
    remove.type = "button";
    remove.title = "删除此步骤";
    remove.addEventListener("click", () => {
      profile.steps.splice(index, 1);
      collapsedSteps.delete(step.id);
      markEditorDirty();
      renderEditor();
    });
    head.append(remove);
    row.append(head);

    if (collapsed) {
      const summary = makeElement("div", "step-collapsed-summary");
      const summaryTarget = step.action === "delay" ? `${Number(step.value) || 0} ms` : targetSummary(step.target);
      const summaryChip = makeElement("span", "target-chip", summaryTarget);
      summaryChip.title = summaryTarget;
      summary.append(
        makeElement("span", "summary-action", ACTION_LABELS[step.action] || step.action),
        summaryChip
      );
      row.append(summary);
      return row;
    }

    if (step.action !== "delay") {
      const targetLine = makeElement("div", "target-line");
      const targetText = targetSummary(step.target);
      const targetChip = makeElement("span", "target-chip", targetText);
      targetChip.title = targetText;
      targetLine.append(targetChip);
      const pick = makeElement("button", "text-button", step.target?.css || step.target?.id ? "重选" : "选择元素");
      pick.type = "button";
      pick.addEventListener("click", () => startPicker("step", index));
      targetLine.append(pick);
      row.append(targetLine);
    }

    const controls = makeElement("div", "rule-controls");
    const action = document.createElement("select");
    for (const [value, text] of Object.entries(ACTION_LABELS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      action.append(option);
    }
    action.value = step.action;
    action.addEventListener("change", () => { step.action = action.value; markEditorDirty(); renderEditor(); });
    controls.append(action);

    if (step.action === "check") {
      const checkLine = makeElement("label", "secret-line");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = step.value === true || step.value === "true";
      check.addEventListener("change", () => { step.value = check.checked; markEditorDirty(); });
      checkLine.append(check, makeElement("span", "", "目标为选中"));
      controls.append(checkLine);
    } else if (step.action === "delay") {
      const delay = document.createElement("input");
      delay.type = "number";
      delay.min = "0";
      delay.max = "30000";
      delay.step = "100";
      delay.value = Number(step.value) || 500;
      delay.placeholder = "毫秒";
      delay.addEventListener("input", () => { step.value = Number(delay.value) || 0; markEditorDirty(); });
      controls.append(delay);
    } else if (step.action === "wait") {
      const timeout = document.createElement("input");
      timeout.type = "number";
      timeout.min = "1000";
      timeout.max = "30000";
      timeout.step = "500";
      timeout.value = Number(step.timeoutMs) || 12000;
      timeout.placeholder = "超时毫秒";
      timeout.addEventListener("input", () => { step.timeoutMs = Number(timeout.value) || 12000; markEditorDirty(); });
      controls.append(timeout);
    } else if (step.action !== "click") {
      const value = document.createElement("input");
      value.type = step.secret ? "password" : "text";
      value.value = step.value ?? "";
      value.placeholder = step.action === "select" ? "选项值或文字" : "填写值";
      value.addEventListener("input", () => { step.value = value.value; markEditorDirty(); });
      controls.append(value);
    } else {
      const clickHint = makeElement("span", "target-chip", "点击此元素");
      clickHint.title = "点击此元素";
      controls.append(clickHint);
    }
    row.append(controls);

    if (step.action === "fill" || step.action === "select") {
      const secretLine = makeElement("label", "secret-line");
      const secret = document.createElement("input");
      secret.type = "checkbox";
      secret.checked = Boolean(step.secret);
      secret.addEventListener("change", () => { step.secret = secret.checked; markEditorDirty(); renderEditor(); });
      secretLine.append(secret, makeElement("span", "", "密码字段"));
      row.append(secretLine);
    }
    return row;
  }

  function renderEditor() {
    const profile = activeProfile();
    if (state.view !== "editor" || !profile) { editor.hidden = true; return; }
    profile.trigger = normalizeProfile(profile).trigger;
    editor.hidden = false;
    $("#editorModeLabel").textContent = state.editorMode === "new" ? "新建规则" : "编辑规则";
    $("#editorHeading").textContent = profile.name;
    const profileToggle = $("#profileEnabled");
    const isNewProfile = state.editorMode === "new";
    profileToggle.checked = profile.enabled;
    profileToggle.disabled = isNewProfile;
    profileToggle.closest(".switch").title = isNewProfile ? "保存规则后可启用或停用" : "立即启用或停用此规则";
    $("#profileName").value = profile.name;
    $("#siteOrigin").value = profile.site.origin;
    $("#sitePath").value = profile.site.pathPrefix;
    $("#siteHash").value = profile.site.hashPrefix;
    const triggerType = profile.trigger.type || "pageLoad";
    document.querySelectorAll("[data-trigger-mode]").forEach((tab) => {
      const active = tab.dataset.triggerMode === (triggerType === "pageLoad" ? "pageLoad" : "condition");
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const triggerConfig = $("#triggerConfig");
    triggerConfig.hidden = triggerType === "pageLoad";
    if (triggerConfig.hidden) {
      $("#triggerType").value = "elementVisible";
    } else {
      $("#triggerType").value = triggerType;
      $("#triggerTargetText").textContent = targetSummary(profile.trigger.target);
      $("#triggerTargetText").title = targetSummary(profile.trigger.target);
      const repeatMode = triggerType === "elementVisible"
        ? Boolean(profile.trigger.options.retriggerWhenReappears)
        : profile.trigger.options.oncePerPage === false;
      $("#triggerOnce").checked = !repeatMode;
      $("#triggerRepeat").checked = repeatMode;
      $("#triggerCooldown").value = Number(profile.trigger.options.cooldownMs) || 1500;
      $("#triggerRepeatLabel").textContent = triggerType === "userClick" ? "每次点击都执行" : "重复执行";
      $("#triggerRepeatHint").textContent = triggerType === "userClick"
        ? "每次点击选中的元素时执行。"
        : "元素再次从不可见变为可见时执行。";
      $("#triggerHint").textContent = triggerType === "userClick"
        ? "监听用户实际点击选中的元素，触发后按顺序执行下面的步骤。"
        : "页面保持打开时监听元素从不存在或不可见变为可见。重复 DOM 变化不会重复执行。";
    }
    stepList.replaceChildren(...profile.steps.map((step, index) => makeStepRow(step, index, profile)));
    emptySteps.hidden = profile.steps.length > 0;
  }

  function setTriggerMode(mode) {
    const profile = activeProfile();
    if (!profile) return;
    profile.trigger = normalizeProfile(profile).trigger;
    profile.trigger.type = mode === "condition" ? (profile.trigger.type === "pageLoad" ? "elementVisible" : profile.trigger.type) : "pageLoad";
    markEditorDirty();
    renderEditor();
  }

  function render() {
    $("#globalEnabled").checked = state.globalEnabled;
    profileOverview.hidden = state.view === "editor";
    renderProfiles();
    renderEditor();
    updateQuickCreateButton();
    renderStatus();
  }

  async function ensurePermission(profile) {
    const origin = normalizeOrigin(profile.site.origin);
    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("没有获得该网站的访问权限");
    return true;
  }

  async function sendToCurrentTab(message, tab = state.currentTab) {
    if (!tab?.id) throw new Error("当前没有可操作的网页标签");
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "content.js"] });
      return chrome.tabs.sendMessage(tab.id, message);
    }
  }

  async function startPicker(purpose, stepIndex = -1) {
    const profile = activeProfile();
    if (!profile) return;
    try {
      await ensurePermission(profile);
      await getCurrentTab();
      const requestId = createId("picker");
      state.picker = { requestId, purpose, stepIndex };
      await sendToCurrentTab({ type: "startPicker", requestId, purpose });
      setStatus("已进入拾取模式，回到网页点击元素，按 Esc 可取消。", false);
    } catch (error) { setStatus(error.message || "无法进入拾取模式", true); }
  }

  async function saveProfile(test = false) {
    const profile = activeProfile();
    if (!profile) return;
    const isNew = state.editorMode === "new";
    try {
      profile.name = $("#profileName").value.trim() || "未命名站点";
      profile.site.origin = normalizeOrigin($("#siteOrigin").value.trim());
      profile.site.pathPrefix = $("#sitePath").value.trim();
      profile.site.hashPrefix = $("#siteHash").value.trim();
      profile.enabled = $("#profileEnabled").checked;
      profile.trigger = normalizeProfile(profile).trigger;
      const triggerTarget = profile.trigger.target || {};
      const hasTriggerTarget = ["id", "name", "placeholder", "ariaLabel", "css", "text"]
        .some((key) => String(triggerTarget[key] || "").trim());
      if (profile.trigger.type !== "pageLoad" && !hasTriggerTarget) {
        throw new Error("请先选择触发元素");
      }
      await ensurePermission(profile);
      const saved = commitEditorProfile(profile, isNew);
      await chrome.storage.local.set({ schemaVersion: 3, profiles: state.profiles, activeProfileId: "", globalEnabled: state.globalEnabled });
      await chrome.runtime.sendMessage({ type: "syncContentScripts" }).catch(() => undefined);
      state.editorDraft = copyProfile(saved);
      state.editorMode = "edit";
      state.editorDirty = false;
      state.expandedGroups.add(profileGroupKey(saved));
      if (!test) {
        resetEditorState();
        render();
        setStatus("规则已保存。", false);
        return;
      }
      setStatus("已保存，正在测试当前页面…", false);
      try {
        await getCurrentTab();
        const result = await sendToCurrentTab({ type: "applyProfile", profile: saved });
        if (!result?.ok) {
          setStatus(result?.message || "测试未完成", true);
          return;
        }
        resetEditorState();
        render();
        setStatus(result.message || "测试完成，规则已生效。", false);
      } catch (error) {
        setStatus(error.message || "规则已保存，但测试未完成。", true);
      }
    } catch (error) { setStatus(error.message || "保存失败", true); }
  }

  function newProfile({ sourceUrl = "", useCurrentPage = false } = {}) {
    const rawSourceUrl = useCurrentPage ? state.currentTab?.url || "" : sourceUrl;
    const parsedSourceUrl = String(rawSourceUrl).trim();
    let site = { origin: "", pathPrefix: "", hashPrefix: "" };
    if (parsedSourceUrl) {
      try {
        site = siteFromUrl(parsedSourceUrl);
      } catch {
        setStatus("URL 无效，请粘贴 http 或 https 开头的完整页面地址。", true);
        return false;
      }
    }
    const profile = normalizeProfile({
      id: createId("profile"),
      name: suggestedProfileName(site, useCurrentPage ? state.currentTab?.title : ""),
      enabled: false,
      site,
      steps: []
    });
    state.editorDraft = profile;
    state.activeId = profile.id;
    state.view = "editor";
    state.editorMode = "new";
    state.editorDirty = false;
    state.expandedGroups.add(site.origin || "未设置网站");
    state.collapsedStepsByProfile.set(profile.id, new Set());
    state.statusMessage = "";
    state.statusError = false;
    render();
    setStatus(site.origin ? `${useCurrentPage ? "已从当前页面" : "已从粘贴的 URL"}提取来源、路径和 Hash，点击“选择元素”开始配置。` : "填写网站来源后，点击“选择元素”开始配置。", false);
    return true;
  }

  async function deleteProfile() {
    const profile = activeProfile();
    if (!profile || !window.confirm(`确定删除“${profile.name}”吗？`)) return;
    state.profiles = state.profiles.filter((item) => item.id !== profile.id);
    state.collapsedStepsByProfile.delete(profile.id);
    resetEditorState();
    await chrome.storage.local.set({ profiles: state.profiles, activeProfileId: "", globalEnabled: state.globalEnabled });
    render();
    setStatus("规则已删除。", false);
  }

  async function setProfileEnabled(enabled) {
    const draft = state.editorDraft;
    if (!draft || state.editorMode === "new") return;
    const saved = state.profiles.find((item) => item.id === draft.id);
    if (!saved) return;
    const previous = saved.enabled;
    const nextEnabled = Boolean(enabled);
    draft.enabled = nextEnabled;
    saved.enabled = nextEnabled;
    renderProfiles();
    try {
      await persistState();
      setStatus(nextEnabled ? "规则已启用，当前页面不追溯执行。" : "规则已停用，当前页面立即停止后续自动执行。", false);
    } catch (error) {
      saved.enabled = previous;
      draft.enabled = previous;
      $("#profileEnabled").checked = previous;
      renderProfiles();
      setStatus(error.message || "更新规则开关失败。", true);
    }
  }

  $("#newProfile").addEventListener("click", () => newProfile());
  $("#quickNewProfile").addEventListener("click", () => newProfile({ useCurrentPage: true }));
  $("#newProfileFromUrl").addEventListener("click", () => {
    const input = $("#newProfileUrl");
    if (!input.value.trim()) {
      setStatus("请先粘贴一个完整的 http 或 https 页面 URL。", true);
      input.focus();
      return;
    }
    if (newProfile({ sourceUrl: input.value })) input.value = "";
  });
  $("#newProfileUrl").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#newProfileFromUrl").click();
  });
  $("#exportBackup").addEventListener("click", () => openExportDialog(state.profiles, "全部站点", "backup"));
  $("#importData").addEventListener("click", openImportDialog);
  document.querySelectorAll("[data-export-mode]").forEach((tab) => {
    tab.addEventListener("click", () => setExportMode(tab.dataset.exportMode));
  });
  document.querySelectorAll("[data-import-mode]").forEach((tab) => {
    tab.addEventListener("click", () => setImportMode(tab.dataset.importMode));
  });
  $("#closeExport").addEventListener("click", () => $("#exportDialog").close());
  $("#cancelExport").addEventListener("click", () => $("#exportDialog").close());
  $("#confirmExport").addEventListener("click", async () => {
    try {
      await executeExport();
    } catch (error) {
      setStatus(error.message || "导出失败", true);
    }
  });
  $("#closeImport").addEventListener("click", () => $("#importDialog").close());
  $("#cancelImport").addEventListener("click", () => $("#importDialog").close());
  $("#chooseImportFile").addEventListener("click", () => $("#importFile").click());
  $("#confirmImport").addEventListener("click", async () => {
    if (state.importMode === "file") {
      $("#importFile").click();
      return;
    }
    const rawText = $("#importClipboardText").value.trim();
    if (!rawText) {
      setStatus("请先粘贴导出的 JSON 内容。", true);
      $("#importClipboardText").focus();
      return;
    }
    try {
      if (await importFromText(rawText)) $("#importDialog").close();
    } catch (error) {
      setStatus(error.message || "导入失败", true);
    }
  });
  $("#importFile").addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    event.target.value = "";
    if (!file) return;
    try {
      if (await importFromFile(file)) $("#importDialog").close();
    } catch (error) {
      setStatus(error.message || "导入失败", true);
    }
  });
  $("#refreshPage").addEventListener("click", async () => { await getCurrentTab(); setStatus("页面信息已刷新。", false); });
  $("#backToProfiles").addEventListener("click", goToOverview);
  $("#globalEnabled").addEventListener("change", async (event) => {
    state.globalEnabled = event.target.checked;
    await chrome.storage.local.set({ globalEnabled: state.globalEnabled });
    setStatus(state.globalEnabled ? "总开关已开启，自动流程恢复。" : "总开关已关闭，自动流程暂停。", false);
  });
  $("#addStep").addEventListener("click", () => {
    const profile = activeProfile();
    if (!profile) return;
    const collapsedSteps = collapsedStepsFor(profile);
    profile.steps.forEach((step) => collapsedSteps.add(step.id));
    const index = profile.steps.length;
    const step = { id: createId("step"), label: "新步骤", action: "fill", secret: false, value: "", enabled: true, timeoutMs: 12000, target: {} };
    profile.steps.push(step);
    markEditorDirty();
    collapsedSteps.delete(step.id);
    renderEditor();
    startPicker("step", index);
  });
  $("#saveProfile").addEventListener("click", () => saveProfile(false));
  $("#testProfile").addEventListener("click", () => saveProfile(true));
  $("#deleteProfile").addEventListener("click", deleteProfile);
  $("#profileEnabled").addEventListener("change", (event) => setProfileEnabled(event.target.checked));
  $("#profileName").addEventListener("input", (event) => { const profile = activeProfile(); if (profile) { profile.name = event.target.value; markEditorDirty(); $("#editorHeading").textContent = profile.name || "未命名规则"; } });
  $("#siteOrigin").addEventListener("input", (event) => { const profile = activeProfile(); if (profile) { profile.site.origin = event.target.value.trim(); markEditorDirty(); } });
  $("#sitePath").addEventListener("input", (event) => { const profile = activeProfile(); if (profile) { profile.site.pathPrefix = event.target.value.trim(); markEditorDirty(); } });
  $("#siteHash").addEventListener("input", (event) => { const profile = activeProfile(); if (profile) { profile.site.hashPrefix = event.target.value.trim(); markEditorDirty(); } });
  document.querySelectorAll("[data-trigger-mode]").forEach((tab) => {
    tab.addEventListener("click", () => setTriggerMode(tab.dataset.triggerMode));
  });
  $("#triggerType").addEventListener("change", (event) => {
    const profile = activeProfile();
    if (!profile) return;
    profile.trigger.type = event.target.value;
    markEditorDirty();
    renderEditor();
  });
  $("#pickTrigger").addEventListener("click", () => startPicker("trigger"));
  function setTriggerRunMode(mode) {
    const profile = activeProfile();
    if (!profile) return;
    const repeat = mode === "repeat";
    profile.trigger.options.oncePerPage = !repeat;
    profile.trigger.options.retriggerWhenReappears = profile.trigger.type === "elementVisible" && repeat;
    profile.trigger.options.maxRuns = repeat ? 50 : 1;
    markEditorDirty();
    renderEditor();
  }
  $("#triggerOnce").addEventListener("change", () => setTriggerRunMode("once"));
  $("#triggerRepeat").addEventListener("change", () => setTriggerRunMode("repeat"));
  $("#triggerCooldown").addEventListener("input", (event) => {
    const profile = activeProfile();
    if (!profile) return;
    profile.trigger.options.cooldownMs = Math.max(0, Math.min(Number(event.target.value) || 0, 30000));
    markEditorDirty();
  });

  chrome.tabs.onActivated.addListener(scheduleTabRefresh);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (state.currentTab?.id !== tabId) return;
    if (changeInfo.url || changeInfo.status === "complete") scheduleTabRefresh();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (state.currentTab?.id === tabId) scheduleTabRefresh();
  });
  chrome.windows.onFocusChanged?.addListener(scheduleTabRefresh);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "pickerResult" && message?.type !== "pickerCancelled") return;
    if (!state.picker || state.picker.requestId !== message.requestId) return;
    if (message.type === "pickerCancelled") {
      state.picker = null;
      setStatus("已退出拾取模式。", false);
      return;
    }
    const profile = activeProfile();
    if (!profile) return;
    if (state.picker.purpose === "trigger") {
      profile.trigger = normalizeProfile(profile).trigger;
      profile.trigger.target = message.target;
      markEditorDirty();
    } else {
      const step = profile.steps[state.picker.stepIndex];
      if (step) {
        step.target = message.target;
        markEditorDirty();
      }
    }
    state.picker = null;
    renderEditor();
    setStatus(`已选择：${targetSummary(message.target)}`, false);
  });

  Promise.all([loadProfiles(), getCurrentTab()]).catch(() => setStatus("读取配置失败，请重新打开面板。", true));
})();
