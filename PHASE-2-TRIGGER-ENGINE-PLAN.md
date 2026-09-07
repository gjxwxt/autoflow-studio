# AutoFlow Studio 二期改造计划：条件触发与可扩展执行引擎

> 面向执行 Agent 的实施文档。本文档描述二期的目标、边界、分支策略、数据模型、运行时架构、界面改造、测试和验收标准。

## 1. 结论与执行原则

当前版本 `2.6.0` 已经适合作为第一版内部测试版：页面加载后按步骤执行、元素选择、填充/勾选/选择/点击/等待、站点管理、导入导出等基础能力已经具备。

但当前运行时仍然是“单个最匹配规则 + 页面加载后自动运行”的模型，不能直接扩展成可靠的会话过期弹窗监听、多触发规则并行执行系统。因此二期必须先改造运行时，再增加界面上的“条件触发”配置。

本期的“可插拔”指内部的注册表和模块接口，不指允许用户加载任意第三方 JavaScript。二期不执行任意脚本、不拦截网络请求、不做外部插件市场，以保证安全性、可测试性和 Chrome 扩展审核可控。

## 2. 当前基线事实

当前交付包位于 `outputs/atrust-auto-login.zip`，Manifest 版本为 `2.6.0`，产品名称为 `AutoFlow Studio`。

执行 Agent 开始前必须确认真实源代码目录。当前工作目录没有 `.git`，因此不能在当前目录直接打 Git tag 或新建分支；必须进入真正的 Git 源仓库后再执行版本冻结和分支操作。

当前实现的关键限制：

- `content.js` 的 `matchingProfile()` 只返回一个最匹配的规则。
- `waitForTarget()` 是限时轮询，不是独立的持续条件触发器。
- 已存在 `MutationObserver`，但它目前主要用于 DOM 变化后重新尝试自动运行当前规则。
- `runKey` 可以阻止同一页面上的成功规则重复执行，但不能替代条件触发器的状态机。
- `shared.js` 中的旧 `trigger` 主要用于兼容迁移，不是完整的条件触发模型。
- 当前 content script 使用 `document_idle`；二期如需尽早建立监听，应评估改为 `document_start`，同时保留页面初次扫描。

## 3. Git 基线、Tag 与分支流程

以下操作必须在真正的 Git 源仓库中执行，不要在打包产物目录或 ZIP 文件上操作。

### 3.1 发布第一版基线

先检查工作区，不覆盖用户已有修改：

```bash
git status --short --branch
git log -5 --oneline
```

确认第一版代码已经提交后，创建基线 tag：

```bash
git tag -a v2.6.0 -m "AutoFlow Studio v2.6.0 baseline"
git show v2.6.0 --stat
```

如果 `v2.6.0` 已经存在，不要强制移动 tag；先检查它是否指向正确提交。若 Manifest 版本与仓库实际发布版本不一致，应先由维护者确认最终 tag 名称。

### 3.2 创建二期分支

```bash
git switch -c feat/phase-2-trigger-engine
```

建议所有二期改动都在该分支完成。阶段性提交应保持可回滚，例如：

```text
feat(runtime): add multi-rule scheduler
feat(runtime): add element-visible trigger
feat(runtime): add user-click trigger
feat(ui): add trigger mode editor
test(extension): add phase-two browser scenarios
```

### 3.3 合并前要求

合并前必须完成：

1. 静态检查和单元测试通过。
2. Chrome 解压安装测试通过。
3. 普通页面加载规则回归通过。
4. 条件触发、多规则、防重复执行测试通过。
5. 导入旧数据并保存后仍可正常执行。
6. 生成新的扩展 ZIP，并确认不包含系统元数据目录或敏感数据。

然后由维护者在主分支合并：

```bash
git switch main
git merge --no-ff feat/phase-2-trigger-engine
```

二期正式版本建议在合并后再决定版本号，例如 `2.7.0`；不要在开发分支提前创建正式发布 tag。

## 4. 二期目标与非目标

### 4.1 目标

- 同一页面允许多个规则同时匹配并独立运行。
- 支持页面加载、元素出现/可见、用户点击三类触发方式。
- 支持动态 DOM、延迟弹窗、SPA 路由和 Hash 变化。
- 触发后继续执行现有的填充、勾选、选择、点击、等待等动作。
- 防止 Observer 重复通知导致同一规则并发执行。
- 支持规则只执行一次、元素重新出现时再次执行、冷却时间和最大执行次数。
- 老版本规则自动迁移为页面加载触发。
- 界面可以清楚表达“触发条件”和“触发后执行”。

### 4.2 非目标

本期不要实现：

- 任意用户 JavaScript 或表达式执行。
- 外部第三方插件动态加载。
- 网络请求拦截、接口响应监听和 Service Worker 网络代理。
- 复杂的条件编程语言。
- 跨 iframe、闭合 Shadow DOM 的全面自动化保证。
- 复杂的任务编排、分支、循环和并行流程。

## 5. 推荐的运行时架构

```text
DOM 变化 / 用户事件 / URL 变化
            ↓
       观测层 Observer
            ↓
       触发器 Registry
            ↓
       规则调度器 Scheduler
            ↓
       动作执行器 Actions
            ↓
      状态、错误与运行记录
```

### 5.1 观测层

每个页面只建立一套共享观测层：

- 一个共享 `MutationObserver`。
- 一个共享的事件委托层，监听 `click`、`input`、`change`、`submit` 等必要事件。
- `hashchange`、`popstate` 和必要的 History API 路由变化检测。
- 页面初次扫描和 DOM 变化后的防抖扫描。

不要为每条规则创建独立的无限轮询器，也不要在每次 MutationObserver 回调里立即执行动作。

MutationObserver 建议观察：

```js
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "class",
    "style",
    "hidden",
    "aria-hidden",
    "disabled"
  ]
});
```

实际字段可根据测试结果收窄，避免观察无关属性造成高频扫描。

### 5.2 规则调度器

调度器负责：

- 获取所有匹配当前 URL 的启用规则，而不是只取一条。
- 维护每条规则的运行状态。
- 合并短时间内重复的 DOM 变化。
- 阻止同一规则并发执行。
- 管理冷却时间、最大执行次数和失败重试。
- 页面切换或规则停用时取消旧任务。

建议状态：

```text
armed      等待触发
queued     已加入执行队列
running    正在执行
cooldown   冷却中
completed  本页面已完成
failed     本次执行失败，可按策略重试
```

### 5.3 防重复与重新武装

MutationObserver 看到变化不等于应该重新执行。元素触发应使用“边沿变化”判断：

```text
条件不满足 → 条件满足：触发一次
条件仍满足：不重复触发
条件满足 → 条件不满足：规则重新武装
条件不满足 → 条件再次满足：按策略再次触发
```

动作执行本身也可能改变 DOM。Observer 不需要暂停，但当前规则处于 `running` 时必须拒绝重复入队；动作完成后再做一次扫描。

建议为规则提供：

```js
{
  oncePerPage: true,
  retriggerWhenReappears: false,
  cooldownMs: 1500,
  maxRuns: 1,
  timeoutMs: 30000
}
```

默认策略：

- 同一规则执行期间的变化：忽略重复触发。
- 目标仍存在且仍可见：不重新触发。
- 目标消失后再次出现：只有 `retriggerWhenReappears` 开启时才再次触发。
- 不同规则互不阻塞，但可以由调度器限制全局并发数。

## 6. 可插拔接口设计

### 6.1 触发器接口

触发器只负责观察和判断条件，不直接执行动作：

```js
{
  id: "elementVisible",
  label: "元素出现",
  schema: {
    target: "element",
    options: ["oncePerPage", "timeoutMs", "cooldownMs"]
  },
  arm(context) {},
  disarm(context) {},
  evaluate(context) {}
}
```

第一批触发器：

1. `pageLoad`：页面初次匹配后执行。
2. `elementVisible`：目标元素存在且可见时，从“不满足”变为“满足”触发。
3. `userClick`：用户实际点击目标元素后触发。

不要把“插件自动点击元素”和“用户点击元素”混为一谈。自动点击属于动作 `click`，用户点击属于触发器 `userClick`。

### 6.2 动作接口

动作模块负责执行具体操作：

```js
{
  id: "fill",
  label: "填充",
  schema: {},
  validate(config) {},
  run(context, config) {}
}
```

继续复用现有动作：

- `fill`
- `check`
- `select`
- `click`
- `wait`
- `delay`

### 6.3 存储模型

建议规则结构：

```js
{
  id: "profile_xxx",
  site: {
    origin: "https://example.com",
    pathPrefix: "/login",
    hashPrefix: "#/login"
  },
  trigger: {
    type: "elementVisible",
    target: {},
    options: {
      oncePerPage: true,
      retriggerWhenReappears: false,
      cooldownMs: 1500,
      timeoutMs: 30000
    }
  },
  steps: []
}
```

旧规则如果没有 `trigger`，迁移为：

```js
trigger: {
  type: "pageLoad",
  options: {
    oncePerPage: true
  }
}
```

所有数据变更必须经过统一 `normalizeProfile()`，并增加 schema 版本，避免编辑器和 content script 各自理解不同格式。

## 7. 界面改造计划

在路径前缀、Hash 前缀和流程步骤之间增加两个 Tab：

```text
[页面加载] [条件触发]
```

### 页面加载

保持当前已有流程配置，默认选中。无需额外显示触发元素。

### 条件触发

增加：

- 触发类型：元素出现、用户点击。
- 触发目标：通过页面拾取器选择。
- 是否只执行一次。
- 元素重新出现时是否再次执行。
- 超时时间。
- 冷却时间。
- 触发后执行的步骤列表。

界面文案应明确区分：

```text
触发条件
触发后执行
```

建议提示语：

```text
页面保持打开时会持续监听条件；满足条件后按防重复策略执行。
```

同一页面需要多个触发方式时，建立多条规则，不要在一条规则里堆叠多个互相独立的触发器。

## 8. 导入、导出与兼容性

- 老版本没有 `trigger` 的规则自动视为页面加载规则。
- 分享导出必须包含触发器配置，但仍然默认隐藏填充值和密码。
- 完整备份包含触发器配置和密码，继续保留明确确认。
- 分享规则的重复识别键必须包含：
  - origin；
  - pathPrefix；
  - hashPrefix；
  - trigger.type；
  - trigger.target 的稳定指纹。
- 同一个页面的“元素出现规则”和“用户点击规则”不应被错误合并。
- 导入冲突时继续使用现有策略：本地已有非空值优先；但应在结果中报告新增、合并、跳过和冲突数量。

## 9. 测试计划

### 9.1 静态与单元测试

至少覆盖：

- URL 匹配和路径/Hash 优先级。
- 旧规则迁移为 `pageLoad`。
- 规则状态转换。
- 同一规则重复 Mutation 不重复执行。
- 元素消失后重新出现的行为。
- 冷却时间和最大执行次数。
- 多规则同时匹配时的独立执行。
- 导入重复规则和触发器差异规则。

### 9.2 Chrome 浏览器测试

使用解压扩展安装，在普通窗口和无痕窗口分别验证：

1. 既有页面加载规则仍能正常执行。
2. 元素延迟 1～10 秒出现时只执行一次。
3. 弹窗出现、消失、再次出现时符合重新触发配置。
4. 点击动作造成大量 DOM 变化时不会递归执行。
5. 页面有多个匹配规则时不会只执行第一条。
6. SPA 路由和 Hash 变化后规则重新匹配。
7. 关闭总开关后所有自动触发停止。
8. 关闭域名或单条规则后不再执行。
9. 页面跳转后旧规则不会继续作用于新页面。
10. 手动“保存并测试一次”不污染自动触发状态。
11. 导入旧版备份后页面加载规则保持兼容。
12. 导入分享数据不会覆盖本地已有密码。

### 9.3 重点场景

- 会话过期弹窗动态插入。
- 弹窗先存在但 `display: none`，随后通过 class 变为可见。
- React/Vue 重新渲染导致目标节点被替换。
- 快速连续点击。
- 目标元素存在但被遮挡或尺寸为零。
- iframe 页面和 Shadow DOM 页面。对于闭合 Shadow DOM，不承诺本期完整支持，应在文档中说明限制。

## 10. 验收标准

二期合并前必须满足：

- 页面加载规则行为与 `2.6.0` 一致。
- 同一页面可以同时保存并启用多条触发规则。
- `elementVisible` 在元素从不存在/不可见变为可见时触发一次。
- 触发规则执行期间的 DOM 变化不会造成并发重复执行。
- 元素重新出现是否再次执行符合配置。
- `userClick` 与自动点击动作语义明确且行为不同。
- 规则停用、总开关关闭、页面跳转能够取消或阻止旧任务。
- 旧规则、旧分享文件和完整备份均可导入。
- 浏览器测试通过，且失败时面板能定位到规则和步骤。
- 新版本扩展包可以在 Chrome 中正常加载。

## 11. 回滚与风险控制

- 二期所有代码只在 `feat/phase-2-trigger-engine` 分支开发。
- 任何运行时重构都必须保留页面加载触发的兼容路径。
- 遇到条件触发不稳定时，先关闭新触发类型，不要破坏旧规则执行。
- 不移动或重写 `v2.6.0` tag。
- 不在导出文件中写入测试账号、密码、Cookie 或当前浏览器会话信息。
- 如果测试发现多规则执行可能导致重复提交，默认将全局并发限制为 1，并要求规则显式允许并发。

## 12. 推荐实施顺序

```text
冻结 v2.6.0
    ↓
创建 feat/phase-2-trigger-engine
    ↓
统一规则 schema 与迁移
    ↓
多规则调度器与状态机
    ↓
共享 MutationObserver / 事件委托
    ↓
elementVisible
    ↓
userClick
    ↓
编辑器 Tab 与条件配置
    ↓
导入导出兼容
    ↓
Chrome 普通窗口 + 无痕窗口测试
    ↓
合并主分支并发布二期版本
```

执行 Agent 不应先只做界面 Tab。只有当运行时已经具备触发器、状态机、防重复和多规则调度能力后，界面配置才有可靠的实际含义。
