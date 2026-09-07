# AutoFlow Studio

AutoFlow Studio 是一个本地优先的 Chrome 扩展，用可视化站点规则描述网页元素、填充值和操作流程，帮助复用重复的登录、填表和页面操作。

当前 `v2.7.0` 在 `v2.6.0` 第一版基线之上，支持：

- Chrome Side Panel 中管理多个网站和页面规则；
- 通过页面拾取器选择 DOM 元素；
- 按顺序执行填充、勾选、选择、点击、等待元素和延时；
- 页面加载后的动态元素等待；
- 规则分享、完整备份、导入导出；
- 全局、域名和单条规则开关。

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
- 下一阶段：在稳定边界内继续增加内部触发器和动作定义。

二期设计和验收标准见 [`PHASE-2-TRIGGER-ENGINE-PLAN.md`](PHASE-2-TRIGGER-ENGINE-PLAN.md)。
下一阶段执行计划见 [`PHASE-3-EXECUTION-RELIABILITY-PLAN.md`](PHASE-3-EXECUTION-RELIABILITY-PLAN.md)。

## 验证

```bash
node --test tests/*.test.mjs
```

浏览器 fixture 还覆盖了手动队列、取消、可信点击、SPA 导航和页面不匹配拒绝；测试使用虚拟数据，不使用真实账号、密码或 Cookie。

## 安全说明

密码只保存在当前 Chrome 配置的本地存储中，不上传到服务器。分享规则默认隐藏填充值；完整备份包含敏感值，使用前请确认导出范围。
