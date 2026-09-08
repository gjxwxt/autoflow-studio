# Phase 4：Runtime Foundation & Observability

状态：执行基线

## 目标

Phase 4 不以增加大量 Trigger/Action 为首要目标，而是把 AutoFlow Studio 从可运行原型提升为：

- 配置和敏感值有明确的最小暴露边界；
- 自动执行、手动测试、条件触发走同一条运行链路；
- 页面导航、配置变更和停用可以可靠地使旧任务失效；
- 关键运行节点有结构化、脱敏、可查询的日志；
- 源码、测试和安装包可以复现并保持一致。

## 当前基线与已知问题

当前 `main` 已包含 v2.7.0 的 Phase 3 可靠性改造，包括单页面队列、AbortController、runtime generation、run token、SPA 导航检测、触发器和动作注册表、Worker 单写入者以及共享逻辑测试。

Phase 4 需要解决的已确认问题：

1. `content.js` 直接读取完整 `chrome.storage.local`，内容脚本可获得所有站点规则和填充值。
2. Panel 的“保存并测试一次”仍将完整 Profile 直接发送给当前页面。
3. Snapshot 没有独立的 revision/document 失效协议，配置变更后需要明确取消旧 Run。
4. 定位器遇到多个候选元素时可能选择第一个；所有产生 DOM 副作用的动作需要唯一匹配。
5. 运行时缺少可查询的结构化事件，无法区分“未匹配、未入队、步骤失败、被取消”。
6. 仓库中存在旧版 `outputs/atrust-auto-login` 产物，源码版本和安装产物可能不一致。

## 目标架构

```text
Panel
  配置 / 编辑 / 导入导出 / 手动运行 / 运行状态
                         │
                         ▼
Service Worker
  Config Repository / Permission / Message Protocol / Log Collector
                         │
                         ▼
Content Runtime
  Document Session / Snapshot / Trigger / Scheduler / Runner
  Locator / Action / Cancellation / Event Producer
                         │
                         ▼
Page DOM
```

### Worker

Worker 是配置和敏感值的信任边界，负责：

- 持有和校验完整 Profile；
- 通过 `storage.local` 保存配置；
- 校验消息来源的 extension id、tab、document、frame 和 URL；
- 返回当前页面所需的最小 Runtime Snapshot；
- 在具体 value-bearing step 执行时按需返回值；
- 配置写入后广播 Snapshot 更新/失效事件；
- 收集脱敏运行事件并保存到会话级日志缓冲区。

### Content Runtime

Content Runtime 不读取完整配置存储，只负责当前页面：

- 建立并维护 document session；
- 请求当前页面 Snapshot；
- 依据 Snapshot 匹配规则；
- 处理 Trigger、Scheduler、Runner、Locator 和 Action；
- 在导航、配置失效或停用时取消旧任务；
- 在执行关键节点产生结构化事件。

### Panel

Panel 只通过 Worker 读写配置和请求运行操作。手动测试使用 `profileId + expectedRevision`，不再把完整 Profile 作为消息 payload 发给页面。

## 敏感数据边界

目标存储边界：

```text
storage.local
  └── Worker / Panel 可访问

Content Runtime
  └── 只获得当前页面的规则元数据
  └── 执行到 value-bearing Action 时 JIT 获取单个值
```

JIT 请求必须同时携带并由 Worker 校验：

```text
documentId
runId
profileId
stepId
snapshotRevision
```

所有 value-bearing Action 默认按需获取值，不依赖用户是否勾选 `secret`：

- `fill`：按需获取；
- `select`：默认按需获取；
- `check`：布尔值可以进入 Snapshot；
- `delay`、`wait`、`click`：不需要用户填充值。

这属于最小暴露设计，不是密码保险箱。密码最终仍然会进入目标网站 DOM。

## Snapshot 与生命周期

Snapshot 至少包含：

```js
{
  revision,
  documentId,
  profiles: [/* 不含 value 的当前页面规则 */]
}
```

每个 Run 绑定 Snapshot revision 和 documentId。

配置写入、规则停用、总开关关闭或页面导航时：

1. Worker 广播 `runtime.snapshotUpdated` 或 `runtime.invalidate`；
2. Content Runtime 增加 `runtimeGeneration`；
3. Abort 当前 Controller；
4. 清空旧队列和旧规则状态；
5. 重新获取 Snapshot；
6. 旧 `runId`、旧 revision、旧 documentId 均不得继续获取值或写入 DOM。

## Trigger、Scheduler 和 Runner

保留同页串行队列：

```text
Trigger → Scheduler → Run Queue → Runner → Locator → Action
```

生命周期约束：

- 页面加载在每个 document session 默认最多执行一次；
- 元素出现只在不可见到可见的边沿触发；
- 用户点击必须是 `event.isTrusted`；
- 同一规则处于 queued/running 时不得重复入队；
- 导航、配置变化、停用和总开关关闭必须取消旧 Run；
- 任何等待和延时都必须可取消；
- MutationObserver 只负责合并扫描请求，不直接执行动作。

Trigger 和 Action 使用静态 Registry 扩展，不引入第三方动态插件框架：

```text
TriggerRegistry: pageLoad / elementVisible / userClick
ActionRegistry: fill / click / check / select / wait / delay
```

## Locator 契约

第一版不引入 AI 定位或复杂评分系统，统一返回三种结果：

```text
0 matches  → NOT_FOUND
1 match   → RESOLVED
>1 matches → AMBIGUOUS
```

以下会产生 DOM 副作用的 Action 必须唯一匹配：

- fill
- click
- check
- select

`wait` 和元素出现 Trigger 可以使用“至少一个匹配”的集合语义。

`AMBIGUOUS` 必须阻断执行，不得退回使用第一个元素。

## Message Protocol

消息统一使用：

```js
{
  protocolVersion: 1,
  type: "runtime.getSnapshot",
  requestId: "...",
  payload: {}
}
```

首批消息：

```text
runtime.getSnapshot
runtime.getStepValue
runtime.requestManualRun
runtime.cancelRun
runtime.snapshotUpdated
runtime.invalidate
log.batch
log.query
log.clear
```

`runtime.requestManualRun` 只接受 `profileId` 和 `expectedRevision`，禁止传完整 Profile。

当前阶段暂不支持 iframe，因此 Content Runtime 请求要求：

- `sender.id === chrome.runtime.id`；
- `sender.tab` 存在；
- `frameId === 0`；
- `documentId` 存在；
- sender URL 和当前 Tab URL 与 Profile 来源匹配。

不符合条件时返回 `UNSUPPORTED_FRAME`、`URL_MISMATCH` 或 `PROTOCOL_INVALID`。

## Structured Runtime Events

日志使用事件模型，而不是散落的 `console.log`：

```js
{
  timestamp,
  seq,
  level,
  event,
  code,
  documentId,
  sessionId,
  runId,
  profileId,
  stepId,
  revision,
  durationMs,
  context: {}
}
```

事件生产端和 Worker Collector 都做一次脱敏/校验。禁止进入日志：

- step.value、input.value、textarea.value；
- Cookie、Token、Authorization；
- 完整 Profile、原始 message payload；
- 带敏感 query/hash 的完整 URL；
- 剪贴板原文。

首批错误码：

```text
LOCATOR_NOT_FOUND
LOCATOR_AMBIGUOUS
ACTION_UNSUPPORTED
ACTION_FAILED
RUN_CANCELLED
RUN_STALE
RUN_TIMEOUT
PROFILE_DISABLED
GLOBAL_DISABLED
URL_MISMATCH
REVISION_STALE
PERMISSION_DENIED
UNSUPPORTED_FRAME
PROTOCOL_INVALID
```

日志放在 `storage.session` 的有界 ring buffer 中，用于当前扩展会话的诊断，不作为永久审计库。Panel 第一版展示最近运行摘要和失败原因，详细 Timeline 后置。

## 测试和发布原则

必须有四层测试：

1. Shared：schema、迁移、脱敏、DTO；
2. Runtime：队列、取消、失效、Locator、日志；
3. Browser：真实 MV3、页面加载、条件触发、导航和停用；
4. Release：manifest、版本、包内容和 hash 一致。

安全契约至少覆盖：

- Content Script 无法直接读取 secrets；
- A.com 无法获取 B.com 的值；
- 错误 Tab、错误 frame、错误 URL 被拒绝；
- 过期 revision/runId/documentId 无法获取值；
- 停用或导航后旧 Run 不再写 DOM；
- `CANARY_SECRET` 不出现在日志、诊断导出和控制台；
- AMBIGUOUS Locator 不产生 DOM 副作用。

发布只以 `extension/manifest.json` 为版本权威来源，自动生成 ZIP。旧版安装目录不再作为第二份源码或发布来源。

## 明确暂缓

本阶段暂不做：多 Flow 编辑器、AI Locator、网络触发、复杂变量、全面 iframe 支持、动态第三方插件、复杂 Timeline UI，以及没有行为收益的全面拆文件重构。

本轮收口后的 Locator 使用策略阶梯：id → css → name + tag → aria-label → placeholder → text。当前策略找到候选后立即决定三态结果；副作用动作要求唯一候选，避免 Picker 同时保存多个特征时把不同策略的候选结果误合并。

手动运行使用一次性 capability：Panel 先由 Worker 校验 tab、URL、profile 和 revision，再写入短时 manualGrant；Worker 向目标顶层 Content 下发 grant，Content 使用 grant 请求 runtime.startRun，Worker 消费 grant 后创建 run lease。Content 不能通过自报 reason: manual 绕过停用规则。

日志事件名、错误码和 context 均采用 allowlist。context 目前只接受已知动作、触发原因、触发类型、阶段枚举，以及 matches、profileCount、attempt、revision 等有界数值；未知字符串和字段直接丢弃。
