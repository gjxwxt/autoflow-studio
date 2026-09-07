# AutoFlow Studio 下一阶段计划：执行可靠性与运行边界加固

> 面向执行 Agent 的实施文档。本文档基于 2026-09-07 的架构评审形成，目标是把评审结论拆成可以逐阶段开发、测试、回滚和验收的任务。
>
> 状态：第一轮已执行。S0–S2 与 S3 的单写入者边界已落地在 `fix/runtime-security`，待完成最终发布验收后合并到 `main`。

## 当前执行进度（2026-09-07）

- S0 已完成：分享白名单脱敏、历史 `target.text` 清理、旧提交步骤迁移、显式数值边界、未知动作/未来版本拒绝执行、worker 冷启动绑定修复。
- S1 已完成：手动测试进入同一页面级队列；延时和目标等待可取消；运行代际、运行 token、页面 URL 校验、可信点击和拾取器隔离已加入。
- S2 已完成核心项：MutationObserver 使用 debounce + 最大扫描延迟；导航轮询、`pageshow`/可见性恢复和冷却期单个待处理激活已加入。
- S3 已完成第一步：Panel 不再直接写配置，统一通过 service worker 串行写入并用 `revision` 检测并发覆盖；Trigger/Action 继续采用现有内部静态 registry。
- 已验证：Node 内置回归测试 5 项通过；真实加载的 MV3 Playwright fixture 通过 13 项，包括手动队列、取消、可信点击、SPA 导航和页面不匹配拒绝。
- S4 验收已完成：在 Chromium 隐身启动参数下通过同一 13 项浏览器回归；版本号已更新为 `2.7.0`，扩展已打包、合并到 `main` 并发布 tag `v2.7.0`。`fix/runtime-security` 保留为可追溯的实施分支。

## 1. 一句话结论

下一阶段先修复“敏感数据边界、操作入口一致性、取消和页面生命周期”这几类可靠性问题，再抽取内部 Trigger/Action registry。暂时保留侧栏 Panel、单条规则一个 trigger、同一页面串行执行和现有三类触发方式，不引入多 flow 编辑器、外部插件框架或任意脚本。

## 2. 基线和事实边界

### 2.1 当前基线

- 仓库：github.com/gjxwxt/autoflow-studio
- 当前分支：main
- 当前基线提交：e903b4b
- 第一版基线 tag：v2.6.0，指向 5da3290
- Chrome 扩展：Manifest V3
- DOM 观察和动作执行在 content script。
- 配置初始化和动态 content script 注册在 service worker。
- 编辑器运行在 Chrome Side Panel。
- 数据保存在 chrome.storage.local。
- 当前数据模型是一个 profile 包含一个 trigger 和一组 steps。

### 2.2 必须区分的状态

以下内容不能混为一谈：

1. 规则配置：持久保存的 profile、trigger、steps 和启用状态。
2. 触发记忆：当前页面中元素是否曾经可见、某个激活是否已经消费。
3. 运行实例：某一次流程的队列、当前步骤、取消信号、结果和计时器。
4. 页面会话：当前 document、SPA 路由和 BFCache 恢复所对应的运行边界。

评审中的“有队列”“有 AbortController”“有 registry”只说明代码中存在相关机制，不能直接作为可靠性已经成立的证据。每项修复必须补对应的行为测试。

### 2.3 已确认的主要问题

以下问题来自评审，执行前仍需用当前源码重新核对。复现数据必须使用虚拟值，不能使用真实 Atrust 账号、密码、Cookie 或 MFA。

| 优先级 | 问题 | 主要影响 |
| --- | --- | --- |
| P0 | 分享脱敏没有清除拾取目标中的 target.text 或其他潜在值 | 分享 JSON 可能带出输入框当前值 |
| P0 | 分享导入合并时可能把本地值绑定到被分享文件改变过的目标 | 目标改变后，已有秘密可能作用于错误元素 |
| P0 | 手动测试绕过统一调度和页面准入检查 | 可能与自动流程并行，或向错误标签页执行 |
| P1 | service worker 初始化引用未绑定的 normalizeProfile | 已有配置冷启动可能失败 |
| P1 | delay 和部分等待不能及时取消 | 队列阻塞，旧流程可能在取消后继续产生副作用 |
| P1 | 用户点击未过滤 event.isTrusted，也未充分排除拾取器和脚本点击 | 自动点击可能递归触发用户点击规则 |
| P1 | SPA history、BFCache、设置异步刷新和规则状态边界不完整 | 旧页面或旧配置可能继续执行，或新路由漏触发 |
| P1 | MutationObserver 可能饿死扫描，目标依赖属性变化也可能漏检 | 动态弹窗长时间不触发或扫描不稳定 |
| P1 | 元素重新出现的激活在 busy/cooldown 期间可能被消费后丢失 | 冷却结束时目标仍在但流程不会执行 |
| P1 | 旧数据迁移顺序可能丢失旧提交步骤，数值 0 可能被默认值覆盖 | 老规则行为变化，用户输入的 0ms 失效 |
| P2 | 未知动作默认降级为 fill，失败和后置验证不完整 | 损坏或未来版本数据可能被错误执行 |

## 3. 本阶段目标和非目标

### 3.1 目标

- 所有自动和手动执行入口进入同一个页面级调度器。
- 每一次运行都有明确的 token、状态和终态，旧运行无法操作新页面或新配置。
- 停用规则、关闭总开关、导航和取消都能停止后续副作用。
- 分享使用字段白名单构造，不能依赖复制整个 profile 后清空几个字段。
- 旧规则迁移可重复、可验证，保留提交步骤和合法的 0 值。
- MutationObserver 只负责产生扫描机会，触发器负责判断，调度器负责排队，动作模块负责 DOM 操作。
- Trigger 和 Action 以简单的内部 registry 形式扩展。
- 通过真实加载的 MV3 fixture 验证 content script、worker、权限、SPA 和无痕窗口行为。

### 3.2 非目标

本阶段明确不做：

- 多 trigger / 多 flow 编辑器。
- 分支、循环、DAG 和复杂任务编排。
- 跨规则并发执行。
- 自动重试登录、提交或网络请求。
- 任意 JavaScript、表达式或第三方动态脚本。
- 网络请求拦截、MFA 自动化和接口注入。
- 全面支持跨域 iframe、closed Shadow DOM 或所有嵌套页面。
- 云同步、密码保险箱、变量系统和大规模 UI 重设计。

## 4. 固定的产品行为契约

### 4.1 规则和页面边界

- 一条规则继续只有一个 trigger 和一组 steps。
- “页面加载后登录”和“会话过期后点击确认”通过同域名下的两条规则实现。
- 规则启用状态是独立配置。已保存规则的开关可以立即持久化，不要求保存其他编辑字段。
- 停用规则会使该规则当前运行失效，并阻止后续步骤产生 DOM 副作用。
- 启用规则不追溯执行当前页面：pageLoad 等下一次页面会话；elementVisible 以当前可见性建立基线；userClick 等下一次可信点击。
- 手动测试是显式运行请求，但必须检查当前标签页的 origin、path、hash、权限和规则快照。

### 4.2 运行和队列边界

- 同一 document 同时最多一个 running 运行实例。
- 同一规则最多一个 queued 实例，重复的自动激活合并，不积累无界队列。
- 用户连续点击属于瞬时意图，规则忙或冷却时默认丢弃重复点击，不延迟补做。
- elementVisible 只在“不满足 → 满足”时产生激活，持续可见不重复触发。
- 重复模式在“满足 → 不满足 → 再满足”时产生新激活。
- 冷却期间最多保留一个待处理激活；冷却结束后重新定位并重验，目标消失则丢弃。
- 一次性模式每个页面会话最多启动一次自动尝试；失败、超时或取消后的计数规则必须由测试锁定。
- cooldownMs = 0 表示无冷却，不能被默认值覆盖。
- 取消只能阻止尚未发生的副作用，不能撤销已经发出的 click、input、change 或网络请求。

### 4.3 运行终态和 token

一次 RunInstance 只能进入一个终态：succeeded、failed、cancelled、timedOut 或 skipped。终态不可被旧异步回调覆盖。

每个异步等待之后、每个步骤开始前、每次 DOM 写入或事件派发前，以及最终结果写回前，都要检查：

- AbortSignal 未取消；
- document session 和 page epoch 仍然有效；
- 规则 revision 仍然匹配；
- 规则仍然启用；
- 当前 URL 仍然匹配；
- 当前 runId 仍然属于该规则。

## 5. 目标内部架构

不以文件数量作为目标，优先建立职责边界。可以继续使用普通 JavaScript 和现有脚本加载方式。

~~~text
配置仓库 / 版本迁移 / 分享 DTO
              ↓
页面运行时：document、路由、权限快照、观测资源
              ↓
Trigger Registry：把页面样本或可信事件变成候选激活
              ↓
Scheduler：去重、准入、队列、取消、冷却、计数
              ↓
Runner：按顺序运行 RunInstance
              ↓
Locator + Action Registry：定位、操作、后置验证
~~~

### 5.1 config-repository

职责：

- 读取并迁移旧格式。
- 校验 profile、trigger、step 的结构和边界。
- 通过明确命令写入配置：保存规则、开关规则、开关总控、导入批次。
- 生成分享白名单 DTO 和完整备份 DTO。
- 在并发编辑时使用 revision 检测冲突。

不负责 DOM、MutationObserver、队列和运行状态。

S0/S1 可以继续使用现有 storage 结构，但必须先修复写入边界。S3 再考虑让 worker 成为唯一写入入口，避免多个 Panel 用旧数组覆盖新数据。

### 5.2 page-runtime

职责：

- 创建 document session 和 page epoch。
- 获取当前匹配规则的不可变快照。
- 管理共享 MutationObserver、事件委托和 URL 生命周期。
- 处理导航、hashchange、popstate、SPA 路由和 BFCache。
- 在规则、配置、权限或页面失效时统一取消订阅和运行。

不决定动作如何填写，也不直接写 storage。

### 5.3 trigger registry

触发器只判断条件，不直接调用 runner。推荐使用静态对象 registry 和每条规则独立的 subscription 工厂：

~~~js
const TriggerDefinition = {
  id: 'elementVisible',
  label: '元素出现',
  validate(config) {},
  create(config, context) {
    return {
      arm(reason) {},
      onScan(sample) {},
      onEvent(event) {},
      dispose() {}
    };
  }
};
~~~

第一批保持：

- pageLoad：初次匹配或真正新页面会话时产生一次候选。
- elementVisible：根据可见性边沿产生候选。
- userClick：只接受可信用户事件，拾取模式期间不触发。

emit(candidate) 只能交给 Scheduler。触发器不能直接执行 steps、创建自己的无限轮询器或持有运行 controller。dispose() 必须幂等。

### 5.4 action registry

动作只负责目标定位、DOM 操作和结果验证：

~~~js
const ActionDefinition = {
  id: 'fill',
  label: '填充',
  targetRequired: true,
  validate(step) {},
  supports(element, step) { return true; },
  async execute(context, step, signal) {}
};
~~~

第一批保持：fill、check、select、click、wait、delay。

delay 不再作为 runner 外部的特殊分支，改成可取消的动作或统一 cancellable sleep。未知动作必须拒绝执行，不能默认降级为 fill。

### 5.5 scheduler 和 runner

建议的内存结构：

~~~js
{
  documentSessionId,
  pageEpoch,
  ruleId,
  ruleRevision,
  runId,
  source: 'automatic' | 'manual',
  status: 'queued' | 'running' | 'succeeded' | 'failed' |
          'cancelled' | 'timedOut' | 'skipped',
  stepIndex,
  controller,
  deadline
}
~~~

Scheduler 负责：

- 自动和手动入口统一入队。
- 在入队、出队和每个动作前重新检查规则和页面资格。
- 同规则去重、全页串行、队列上限和队列超时。
- 配置更新、停用、导航和总开关变化时使旧 token 失效。
- 只将不可变规则快照放入队列，不保存旧 DOM 引用。

Runner 负责：

- 按步骤顺序调用 Action registry。
- 每步使用有界的定位超时。
- 每次等待和 DOM 副作用前检查 token。
- 只产生一个终态，并返回不含敏感值的结果码。

不引入事件总线、middleware、依赖注入容器或用户可加载插件。当前 registry 是内部扩展点，不是第三方插件市场。

## 6. 分阶段实施计划

每个阶段都必须可以独立审查和回滚，不把所有风险留到最后。

### S0：发布阻断修复与回归基线

目标：先让当前功能在安全边界和旧数据边界上可控。

任务：

1. 修复 service worker 对 normalizeProfile 的绑定，增加全新安装、已有配置和 worker 冷启动冒烟测试。
2. 重写分享导出为白名单 DTO：
   - 分享不包含 step.value、密码字段和运行状态；
   - 输入、密码、textarea、select 的 target.text 不采集、不导出；
   - 清理历史规则中已经存在的值型 target.text；
   - 不把完整 profile 复制后局部清空作为唯一脱敏策略。
3. 收紧分享导入合并：目标、动作或结构变化时不自动继承本地秘密；结构明确相同且目标未变时才保留本地值；冲突和待补值必须报告。
4. 重写旧格式迁移顺序：先读取旧 fields 和旧 trigger.enabled，补齐旧提交步骤，再生成当前规范；迁移应幂等并保留稳定 ID。
5. 修复数值边界：使用显式有限数值判断，cooldownMs = 0 保持为 0；未知版本和未知动作拒绝执行。
6. 为以上六项问题建立最小 Node 回归测试，虚拟值使用 alice、secret 等测试数据。

出口条件：

- 旧数据迁移后提交步骤仍存在。
- 分享 JSON 中不存在虚拟密码或输入框值。
- 目标变化时本地秘密不会自动绑定到新目标。
- worker 在已有配置冷启动时无 ReferenceError。
- 0ms 和未知动作测试结果符合契约。

### S1：统一执行入口与取消契约

目标：自动执行和手动测试使用同一个 scheduler，不再存在危险的 force 旁路。

任务：

1. 引入 document session、page epoch、rule revision 和 runId。
2. 将 applyProfile 的手动入口改为创建 source: manual 的 RunInstance 并进入同一队列。
3. 手动测试可以按照现有产品语义绕过自动启用限制，但不能绕过当前 origin/path/hash、标签页身份、权限、规则校验和页面互斥。
4. 实现可取消 sleep，覆盖 delay、wait、定位等待和 cooldown timer。
5. 在每个 await、每步前、每次 DOM 写入和最终结果回写前执行 token 校验。
6. 统一终态，取消后不增加成功次数，不被旧 finally 改写为 succeeded。
7. userClick 检查 event.isTrusted，拾取器激活时屏蔽自动触发；picker 会话绑定 tab、document、rule、step 和 requestId。
8. 明确失败、超时、取消、队列超时、重复触发和冷却的计数规则，并加入测试。

出口条件：

- 自动和手动运行共用同一个 scheduler。
- 同一 document 同时最多一个 running。
- 取消最终 delay 后在前台测试环境中 100ms 内完成收尾，后续无 DOM 副作用。
- 手动测试切换到不匹配页面时不产生填充、点击或事件派发。
- 脚本 click 不会触发 userClick 规则。

### S2：页面生命周期与观察层加固

目标：让动态 DOM、SPA 路由、元素重新出现和配置刷新拥有明确边界。

任务：

1. 把 MutationObserver 回调改为共享调度器的扫描机会：
   - 使用 dirty 标记和固定批次窗口；
   - 设置最大等待时间，避免持续 mutation 让扫描饿死；
   - 只观察必要属性，并覆盖经过测试的目标依赖属性；
   - 扫描中不直接执行动作。
2. 抽出 locator：支持稳定属性、可见性检查、候选排序和动作支持校验；不再永远取隐藏的第一个同名节点。
3. 为 elementVisible 增加 pending activation：busy/cooldown 时最多保留一个待处理激活，出队前重新定位和重验，目标消失则丢弃。
4. 建立独立导航适配层，使用真实扩展 fixture 验证 pushState、replaceState、hash、popstate 和 A→B→A；不要把 isolated world 中的 history patch 当作已验证的 SPA 保证。
5. 处理 BFCache：pagehide 取消运行并释放资源；pageshow.persisted 重新获取配置和订阅，不恢复旧运行，不重复提交 pageLoad。
6. 引入配置快照代次或 requestGeneration，旧的异步读取不能覆盖新快照；按受影响规则失效，避免保存无关规则取消全页任务。
7. 保留当前设置变化不追溯当前页面的语义：pageLoad 不补跑，elementVisible 重新建基线，userClick 等可信事件。

出口条件：

- 每秒 200 次 mutation 持续 60 秒不会导致无限队列或扫描饿死。
- 元素持续可见不重复执行；隐藏后重新出现按模式执行。
- 冷却期间重新出现且保持可见的元素，在冷却结束后最多补一次。
- 真实 MV3 fixture 中 SPA 路由改变能取消旧运行并建立正确的新页面会话。
- BFCache 返回不会恢复旧步骤或重复提交。

### S3：配置仓库与内部扩展边界

目标：在 S0～S2 的行为稳定后，减少配置、触发器、动作之间的耦合。

任务：

1. 把 normalizeProfile 拆成“识别版本 → 迁移 → 校验 → 规范化”流程；读取本身不反复写 storage。
2. 评估并实现 worker 单写入入口：
   - saveRule(id, expectedRevision, definition)；
   - setRuleEnabled(id, enabled)；
   - setGlobalEnabled(enabled)；
   - importBatch(payload, expectedRevision)。
3. Panel 监听已提交配置变化：无草稿时刷新；编辑中保留草稿，revision 冲突时提示并让用户选择合并或覆盖。
4. 只有在 S0～S2 通过后，才决定是否引入 schema v4。若升级，建议将运行次数语义从 trigger options 中抽为 runPolicy，但不要同时引入变量、秘密库和 flow 系统。
5. 实现静态 Trigger registry 和 Action registry；新增一个内部测试动作时不应修改 scheduler。
6. 让 content 只获取当前页面匹配的不可变规则快照，不向页面脚本暴露其他网站的完整凭据。
7. 评估 chrome.storage.local.setAccessLevel 和 worker 消息边界；worker 必须校验 sender 的 tab、frame 和 URL。
8. 对动态 content script 注册做 single-flight，同一 origin 的授权失败不能阻断其他站点。

出口条件：

- Panel 不再用旧的完整 profile 数组静默覆盖其他窗口的新修改。
- Trigger/Action registry 有真实调用测试，未知 id 不执行。
- 导入、分享、备份、旧格式迁移在新旧数据结构下结果明确。
- 新增一个动作实现无需修改 scheduler 的准入和状态机。

### S4：真实扩展验收与发布

目标：把“代码中有机制”变成“在 Chrome 中有证据”。

任务：

1. 使用独立 Chrome profile 加载 extension/，不接触用户日常浏览器数据。
2. 使用本地 fixture 覆盖异步登录、延迟弹窗、隐藏/重新出现、SPA、BFCache、用户点击、iframe 限制和多规则。
3. 使用无痕窗口单独验证配置共享、运行状态隔离和权限行为；不把无痕模式宣传成独立密码库。
4. 执行静态检查、Node 逻辑测试、真实 MV3 E2E 和手工验收。
5. 生成唯一来源的扩展 ZIP，检查 manifest 版本、文件列表和压缩包中没有测试数据、系统元数据或备份文件。
6. 更新 README、扩展使用说明、已知限制和发布说明。

## 7. 测试矩阵

### 7.1 纯逻辑测试

- normalizeProfile：旧 fields、旧 trigger、缺 ID、重复 ID、未知版本、未知动作、0ms、迁移幂等。
- 分享 DTO：step value、secret、target.text、value 属性选择器和额外字段均按策略处理。
- 导入合并：完全相同结构、目标变化、动作变化、值冲突、步骤新增和步骤删除。
- Scheduler：去重、顺序、run token、一次性、重复模式、冷却、队列上限和终态唯一性。

### 7.2 DOM fixture 测试

- 延迟挂载登录表单：点击密码登录后再出现账号密码框。
- 弹窗会话过期：页面保持打开较长时间后出现确认弹窗。
- display、visibility、hidden、aria-hidden、尺寸和祖先状态变化。
- 节点移除再插入、同名隐藏节点和可见节点并存。
- fill、select、check、click、wait、delay 的后置验证和错误停止。
- 自动 click 不触发 userClick；真实用户点击子节点能匹配目标。
- 规则停用、总开关关闭、导航和取消过程中的旧回调。

### 7.3 真实 Chrome 扩展测试

- 全新安装和已有 storage 的 worker 冷启动。
- Side Panel 当前标签页切换、窗口切换和权限拒绝。
- 动态注册 content script 的多 origin 同步和 single-flight。
- pushState、replaceState、hash、popstate、A→B→A。
- BFCache 返回，确认旧运行不恢复、不重复提交。
- 普通窗口和无痕窗口同时运行。
- 同页三条规则同时候选时顺序稳定且最多一个 running。
- 手动测试和自动流程同时发生时共用队列，不向错误页面执行。

## 8. 性能与安全门槛

这些是发布前要测量的目标，不得在没有证据时宣称已经达标：

- 高频 mutation 下扫描有界，不产生无界 queue、timer 或 listener。
- 10,000 个 DOM 节点和 20 条可见性规则的单次扫描目标 P95 不超过 10ms，并记录固定硬件和 Chrome 版本。
- 前台 mutation 后候选检测目标 P95 不超过 300ms。
- 无 mutation 的必要兜底检查目标 P95 不超过 750ms。
- 取消在事件循环可运行的前台 fixture 中收到后 100ms 内完成收尾。
- 日志只允许记录 ruleId、runId、stepId、动作类型、结果码和时长，不记录 value、完整 profile、页面 HTML、完整 URL 查询参数或敏感异常文本。
- 分享白名单中不存在填充值、密码值、输入控件当前文本或运行状态。
- origin、path、hash、tabId、frameId 和 document session 都必须在执行前校验。

## 9. Git 和发布策略

### 9.1 分支

开始写代码前检查工作区，不覆盖用户已有修改：

~~~bash
git status --short --branch
git log -5 --oneline --decorate
git remote -v
~~~

建议按阶段创建短分支：

- fix/runtime-security：S0
- fix/runtime-contract：S1
- fix/page-lifecycle：S2
- refactor/config-boundaries：S3

如果维护者希望减少分支，也可以使用 phase-3-execution-reliability 分支，但每个阶段必须独立提交、独立测试和可回滚。

### 9.2 提交粒度

建议提交保持单一目的：

~~~text
fix(security): sanitize picked targets and shared exports
fix(import): prevent secret rebinding during merge
fix(worker): restore initialization with existing profiles
fix(runtime): unify manual admission and cancellation
fix(runtime): make waits and delays cancellable
fix(triggers): isolate trusted user clicks and picker mode
fix(navigation): invalidate runs across page lifecycles
refactor(config): introduce versioned repository boundary
test(extension): cover isolated MV3 runtime scenarios
~~~

每个提交都应说明：行为变化、测试命令、是否涉及数据迁移、是否可能影响旧规则。

### 9.3 合并和 tag

- v2.6.0 不移动、不覆盖。
- S0～S2 通过后再决定是否进入 S3，不因为 registry 已存在提前宣称架构完成。
- S4 通过后从确认的 main 源码生成扩展 ZIP。
- Manifest、README、发布说明和新 tag 版本必须一致。
- 下一次完整稳定版可以考虑 2.7.0，但只有维护者确认验收后才创建正式 tag。
- 回滚使用 git revert，涉及 schema 变化时必须同时保证旧代码不会误读新数据。

## 10. 执行 Agent 的工作顺序

1. 读取当前仓库的 AGENTS/CLAUDE 指令和本计划。
2. 检查 git status、当前 commit、remote 和真实源码目录。
3. 用虚拟数据重新复现 S0 列出的六项问题，先把复现变成测试。
4. 只实施 S0，运行静态检查和回归测试，提交并等待审查。
5. 再实施 S1，重点审查 manual/automatic 是否真的共用 scheduler，以及取消后是否还有副作用。
6. S1 通过后实施 S2，必须进入真实 MV3 fixture 验证 SPA、BFCache 和高频 mutation。
7. S2 通过后再评估 S3 的存储边界和 schema v4；没有必要为了抽象而抽象。
8. S4 完成后才进行扩展打包、合并和版本发布。

每一步都要报告：已确认事实、修改内容、测试证据、剩余风险和未做事项。没有测试证据的能力只能写成“待验证”。

## 11. 阶段总验收标准

下一阶段完成的最低标准：

1. 六项已复现问题均有自动回归测试且通过。
2. 所有自动和手动入口都经过统一调度和页面准入检查。
3. 同一 document 最多一个 running，每个 run 只有一个终态。
4. 取消、停用、导航和配置更新后，旧 run 不再产生 DOM 副作用。
5. 分享数据经过白名单构造，不因 target.text 或未知字段泄露值。
6. 导入目标变化时不会自动把本地秘密转移到新目标。
7. 旧规则迁移幂等，提交步骤、稳定 ID 和合法 0 值得到保留。
8. 高风险行为在真实隔离 Chrome 扩展中验证，不以普通网页模拟代替。
9. 现有侧栏、单 trigger 模型、同页串行执行和当前开关语义保持可用。
10. README、manifest、测试结果、打包文件和 Git 提交来源一致。

## 12. 明确延期的后续议题

以下能力只有在真实用户场景证明必要后再立项：

- 同一规则配置多个 trigger 或多个 flow。
- 共享步骤模板、变量和秘密引用。
- 跨规则依赖、并行和 DAG。
- 自动重试提交或网络动作。
- Shadow DOM、iframe 和跨域页面的全面支持。
- 云同步、独立密码库和更强的秘密管理。
- 第三方动态插件、脚本市场和任意表达式。
- 复杂优先级编辑器和运行历史中心。

这些能力不是当前可靠性加固的前置条件。先把“会不会误操作、会不会泄露、能不能停止、旧数据是否可恢复”做实，再扩展能力范围。
