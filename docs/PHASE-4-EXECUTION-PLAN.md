# Phase 4：Runtime Foundation & Observability 执行计划

状态：待执行 / 执行中

总体设计基线：[`PHASE-4-RUNTIME-ARCHITECTURE.md`](./PHASE-4-RUNTIME-ARCHITECTURE.md)

## 执行原则

- 从当前 `main` 的 v2.7.0 代码开始，不推倒重来。
- 先建立安全和生命周期契约，再扩展能力。
- 每个阶段同时补对应测试，不把测试全部推迟到最后。
- 不接触真实账号、密码、Cookie、MFA；测试只使用虚拟值和 CANARY 标记。
- 不引入新依赖，优先使用 Chrome 原生 API、Node 内置测试和现有浏览器夹具。
- 所有配置写入继续经过 Worker；所有自动和手动执行进入同一 Scheduler。

## S0：发布基线与仓库护栏

目标：确保测试和用户安装的是同一份代码。

任务：

- 删除或移出旧版 `outputs/atrust-auto-login` 发布目录；
- 增加最小 package 脚本，从 `extension/` 生成唯一 ZIP；
- 版本只读取 `extension/manifest.json`；
- 校验 ZIP 内文件清单、manifest 版本和源码版本；
- 将浏览器测试入口从 `work/` 整理到 `tests/browser/`，测试夹具保留虚拟页面；
- 明确 `outputs/` 只保存可重新生成的交付包，不作为源码。

验收：

- 源码和 ZIP 的 manifest 版本一致；
- ZIP 不包含测试数据、真实凭据或旧版文件；
- 浏览器测试加载的就是本次生成的 ZIP 或同一 extension 目录；
- `git status` 不因测试产生未预期的源码改动。

## S1：消息协议与运行身份

目标：先固定消息命名、请求结构和当前 document 身份。

任务：

- 在 `shared.js` 增加 protocol version、requestId 和错误码常量；
- 统一 Worker、Panel、Content 的消息构造和响应格式；
- Content 启动时建立 `documentId + sessionId`；
- Worker 统一校验 extension id、tab、frame、document 和 URL；
- 当前阶段拒绝 iframe 请求；
- 将 `applyProfile` 重命名为 `runtime.requestManualRun`，payload 只允许 profileId 和 expectedRevision。

验收：

- 缺 protocolVersion、未知 type、错误 payload 可预测失败；
- 错误 Tab、错误 URL、非顶层 frame 被拒绝；
- 自动执行和手动测试都不再以完整 Profile 作为入口消息。

## S2：Storage Boundary 与最小 Snapshot

目标：阻止 Content Script 直接读取完整 profiles 和 secrets。

任务：

- Worker 设置 `storage.local` 的受信任上下文访问级别；
- Content 删除对 `chrome.storage.local.get` 的依赖；
- 增加 `runtime.getSnapshot`；
- Worker 根据真实 sender 和当前 URL 返回当前页面的规则元数据，不返回 value-bearing 值；
- 增加 `runtime.getStepValue`，只返回当前合法 Run 的单个值；
- 自动运行和手动运行都通过 Worker 获取运行授权；
- 对 `fill`、`select` 等 value-bearing Action 默认采用 JIT 获取值。

验收：

- Content Script 直接读取 `storage.local` secrets 失败；
- A.com Runtime 不能获取 B.com Profile；
- 未授权 profileId、stepId、runId、revision 无法获取值；
- `CANARY_SECRET` 只在正确的目标步骤、正确的 Run 中出现。

## S3：Snapshot Revision 与失效协议

目标：配置变更后旧 Snapshot 和旧 Run 不能继续操作页面。

任务：

- Snapshot 携带 revision、documentId；
- Run 绑定 snapshot revision、documentId 和 runId；
- Worker 写配置后广播 `runtime.snapshotUpdated` 或 `runtime.invalidate`；
- Content 收到失效事件后 abort、清队列、增加 generation 并重新获取 Snapshot；
- 页面导航、pageshow 和 URL 变化都建立新的 document session 语义；
- `getStepValue` 拒绝旧 revision、旧 runId 和旧 documentId。

验收：

- 正在 delay/wait 的旧 Run 在配置停用后立即停止；
- 停用或总开关关闭后不再执行后续步骤；
- SPA 导航后旧页面流程不能写入新页面；
- 旧 Snapshot 不能覆盖新配置状态。

## S4：唯一 Locator Contract

目标：所有产生 DOM 副作用的动作遇到多匹配必须阻断。

任务：

- 将 `findTarget` 改为返回结构化定位结果；
- 实现 `NOT_FOUND / RESOLVED / AMBIGUOUS` 三态；
- fill、click、check、select 要求唯一匹配；
- wait 和元素出现 Trigger 保留“至少一个匹配”语义；
- 执行动作前记录定位策略和匹配数量，不记录元素值；
- 保留当前简单定位顺序，不引入 AI 或复杂评分。

验收：

- 多匹配的 fill/click/check/select 不触发 DOM 副作用；
- 找不到目标返回稳定错误码；
- 唯一目标的现有 Atrust 登录流程行为不回归。

## S5：Structured Runtime Events

目标：能回答“为什么没有执行”。

任务：

- 增加统一事件生产器；
- 引入 `timestamp/seq/level/event/code/documentId/sessionId/runId/profileId/stepId/revision`；
- Trigger、Scheduler、Run、Step、Locator、配置失效均产生日志；
- Content 端白名单构造，Worker 端再次校验和脱敏；
- Worker 使用 `storage.session` 保存有界 ring buffer；
- 批量发送日志，避免 MutationObserver 高频变化造成写入风暴；
- 明确 `seq` 的产生方和接收顺序，不让业务逻辑依赖时间戳排序。

验收：

- 页面加载规则能记录匹配、入队、执行和结束状态；
- 找不到元素、多匹配、取消、过期和 URL 不匹配都有稳定 code；
- `CANARY_SECRET` 不出现在日志或诊断数据；
- 日志上限和清理策略生效。

## S6：最小运行状态 UI 与诊断导出

目标：让用户无需打开 DevTools 就能判断规则状态。

任务：

- 在 Panel 展示当前页面最近一次运行摘要；
- 显示规则名、触发类型、成功/失败/取消、步骤编号和错误原因；
- 区分“面板刷新当前页面信息”和“浏览器页面重新加载”；
- 增加脱敏诊断信息复制；
- 不做完整 Timeline、永久运行历史和复杂日志检索。

验收：

- 用户能判断规则未匹配、未入队、执行中、步骤失败或被取消；
- 诊断内容不包含值、Cookie、Token、剪贴板或敏感 URL 参数；
- 面板关闭后，当前会话日志仍可按限制读取。

## S7：回归、浏览器验收与发布门禁

目标：把 Phase 4 变成可重复验证的工程能力。

任务：

- 将浏览器夹具和 13 项既有行为测试正式纳入仓库；
- 增加安全契约测试、失效协议测试、Locator 多匹配测试和日志脱敏测试；
- 用无痕 Chromium 验证扩展安装、页面重载、SPA 导航和条件触发；
- 从干净目录生成 ZIP 并重新安装验证；
- 更新 README、变更记录和版本号；
- 在合并前执行完整测试和产物 hash 校验。

验收门槛：

- Shared、Runtime、Browser、Package 测试全部通过；
- 无真实凭据进入代码、测试夹具、日志或产物；
- `main` 只接收通过验收的提交；
- 发布包可以由源码重新生成且 hash 可核对。

## 分支与提交策略

本阶段使用独立分支：

```text
codex/phase-4-runtime-foundation
```

提交按可回滚能力拆分：

```text
docs: add phase 4 runtime baseline
build: make extension package reproducible
feat(protocol): add runtime message contracts
feat(runtime): enforce storage boundary
feat(runtime): add snapshot invalidation
feat(locator): reject ambiguous side effects
feat(observability): add structured runtime events
feat(panel): show run diagnostics
test: promote browser and security contracts
```

每一步完成后先跑对应测试，再进入下一步。没有必要的阶段不合并，不以“大重构完成”作为验收标准。

## 当前执行状态

- [x] 建立 Phase 4 独立分支
- [x] 写入总体架构基线
- [x] 写入执行计划
- [x] S0 发布基线与仓库护栏（可复现 ZIP 脚本已存在，待最终发布验收）
- [x] S1 消息协议与运行身份
- [x] S2 Storage Boundary 与最小 Snapshot
- [x] S3 Snapshot Revision 与失效协议
- [x] S4 唯一 Locator Contract
- [x] S5 Structured Runtime Events
- [x] S6 最小运行状态 UI 与诊断导出
- [ ] S7 回归、浏览器验收与发布门禁

## 本轮实现记录（2026-09-08）

- Panel 增加当前页面的最近运行摘要、日志弹窗、清空与脱敏诊断复制；
- Worker 将日志保存在 storage.session，Panel 只按无 query/hash 的页面地址过滤；
- 修复 delay 动作重复等待一次的问题；
- Worker 仅通过 storage.onChanged 广播 snapshot 失效，避免单次保存重复重置页面运行时；
- Shared 测试覆盖 JIT 值隐藏、日志脱敏和 value-bearing action 分类。

尚需完成 S7 的真实 Chrome 无痕验收与发布包安装回归；该项不能以 Node 单元测试替代。
