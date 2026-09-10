# AutoFlow Studio

AutoFlow Studio 是一个本地优先的 Chrome 扩展，用可视化站点规则描述网页元素、填充值和操作流程，帮助复用重复的登录、填表和页面操作。

当前 `v2.7.1` 在 `v2.6.0` 第一版基线之上，支持：

首次安装默认不创建任何站点规则；已有规则不会因扩展升级被删除。

- Chrome Side Panel 中管理多个网站和页面规则；
- 使用 AutoFlow Studio 的步骤与指针图标作为扩展及面板品牌标识；
- 通过页面拾取器选择 DOM 元素；
- 按顺序执行填充、勾选、选择、点击、等待元素、延时和刷新页面；
- 页面加载后的动态元素等待；
- 规则分享、完整备份、导入导出；
- 全局、域名和单条规则开关。
- 刷新动作的页面导航隔离、脱敏运行日志和空白安装初始化；
- [隐私政策](https://gjxwxt.github.io/autoflow-studio/privacy-policy.html)。

## 本地安装

1. 打开 Chrome 的 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库的 `extension/` 目录。
5. 固定扩展并打开 Side Panel。

详细使用说明见 [`extension/README.md`](extension/README.md)。

## 开发路线

- `v2.6.0`：页面加载型自动化规则基线。
- `feat/phase-2-trigger-engine`：条件触发、多规则调度和可扩展触发器架构。
- `v2.7.0`：执行队列、取消、页面生命周期和数据安全加固。
- `v2.7.1`：修复刷新与页面加载规则抢跑，补齐运行诊断，并完成商店审核版本准备。
- 下一阶段：上架反馈、安全边界和运行时维护，见 [Phase 5 计划](docs/PHASE-5-STORE-SECURITY-PLAN.md)。

二期设计和验收标准见 [`PHASE-2-TRIGGER-ENGINE-PLAN.md`](PHASE-2-TRIGGER-ENGINE-PLAN.md)。
执行可靠性历史计划见 [`PHASE-3-EXECUTION-RELIABILITY-PLAN.md`](PHASE-3-EXECUTION-RELIABILITY-PLAN.md)。
Runtime Foundation 设计与执行记录见 [`docs/PHASE-4-RUNTIME-ARCHITECTURE.md`](docs/PHASE-4-RUNTIME-ARCHITECTURE.md) 和 [`docs/PHASE-4-EXECUTION-PLAN.md`](docs/PHASE-4-EXECUTION-PLAN.md)。

## 验证

```bash
node --test tests/*.test.mjs
```

浏览器 fixture 还覆盖了手动队列、取消、可信点击、SPA 导航和页面不匹配拒绝；测试使用虚拟数据，不使用真实账号、密码或 Cookie。

## 安全说明

密码只保存在当前 Chrome 配置的本地存储中，不上传到服务器。分享规则默认隐藏填充值；完整备份包含敏感值，使用前请确认导出范围。
