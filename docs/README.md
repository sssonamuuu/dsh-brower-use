---
description: "Index of the DSH Browser Bridge project documentation: plan, architecture, protocol, install, testing, TODO, and development log."
kind: "project-docs-index"
---

# DSH Browser Bridge 文档

项目目标：让 DSH Agent 在用户**日常使用、已登录**的 Chromium 浏览器标签页上完成前端调试，
而不是另开一个无登录态的浏览器。

## 阅读顺序

1. [PLAN.md](PLAN.md) —— 范围、阶段、验收标准、明确不做的事。
2. [ARCHITECTURE.md](ARCHITECTURE.md) —— 三层结构、为什么不用 CDP、浏览器兼容策略。
3. [PROTOCOL.md](PROTOCOL.md) —— WS 命令/事件、配对、能力协商、错误码。
4. [INSTALL.md](INSTALL.md) —— 安装宿主插件、加载扩展、配对、排障。
5. [TESTING.md](TESTING.md) —— 自动化测试与手工验收矩阵。
6. [VERIFICATION.md](VERIFICATION.md) —— v0.1 自动化、DSH 激活、真实 Chrome 端到端记录。
7. [TODO.md](TODO.md) —— 逐项进度（会随开发更新）。
8. [DEVLOG.md](DEVLOG.md) —— 按时间的开发记录、决策和踩坑。

## 文档约定

- 所有文档使用 YAML front matter：`description` + `kind`，和 DSH 的 package reference 文档保持一致。
- 协议字段以 [PROTOCOL.md](PROTOCOL.md) 为准；代码里的常量必须与协议版本一致。
- 每次会话结束前更新 TODO 和 DEVLOG，不把「已完成」只留在聊天记录里。