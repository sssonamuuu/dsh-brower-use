---
description: "Living TODO list for DSH Browser Bridge, grouped by phase, with status updated as development proceeds."
kind: "project-todo"
---

# TODO — DSH Browser Bridge

状态：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

## P0 文档与骨架

- [x] README + 文档索引
- [x] PLAN（范围、阶段、验收、风险）
- [x] ARCHITECTURE（三层结构、浏览器兼容、安全）
- [x] PROTOCOL（HTTP/WS/命令/事件/错误）
- [x] INSTALL（安装、配对、排障）
- [x] TESTING（自动化 + 手工矩阵）
- [x] VERIFICATION（实测记录）
- [x] TODO / DEVLOG
- [x] 目录骨架

## P1 通路与基础工具

### Host

- [x] `ws.js` 零依赖 WebSocket 服务端（握手、掩码、分片、64 位长度、ping/pong/close）
- [x] `bridge-server.js`：`/hello`、`/pair`、`/health`、`/ws`
- [x] token 持久化 + 自动配对（扩展 Origin 领 token）+ 配对码后备 + 限速
- [x] 客户端注册、hello 校验、心跳超时、WS Origin 检查
- [x] 命令发送：id、超时、断线 reject、AbortSignal
- [x] 插件入口 `index.js`：cordis `apply`、`ctx.effect` 生命周期、systemPrompt 指引
- [x] 工具注册：status / tabs / snapshot / read / click / type / eval / screenshot
- [x] 截图落盘 + PNG/JPEG 尺寸解析

### 扩展

- [x] `manifest.json`（Chrome/Edge 共用）
- [x] `content/collector.js` 骨架与注入哨兵
- [x] `content/relay.js` postMessage 转 runtime
- [x] `background.js`：端口扫描、`/hello` 自动领 token、`/pair` 后备、WS、重连退避、心跳
- [x] 命令路由：tabs.* / page.*
- [x] `scripting.executeScript` ISOLATED / MAIN 封装
- [x] tab 解析与受限页面错误
- [x] popup 状态 + 自动连接/后备配对
- [x] options token/端口/测试/忘记
- [x] 图标

## P2 调试能力

- [x] console hook（log/info/warn/error/debug）+ 安全序列化
- [x] `window.onerror` + `unhandledrejection`
- [x] fetch hook（请求、响应、body 克隆、超时保护）
- [x] XHR hook（open/send/headers/loadend/body）
- [x] 事件转发 + tab/frame 打戳 + seq
- [x] Host 缓冲：console 2000/tab、network 1000/tab、body 256KB
- [x] `browser_console`（级别过滤、增量、清空）
- [x] `browser_network`（列表、详情、body、清空、过滤）
- [x] `browser_wait`（selector/text/console_error/network_idle）
- [x] Web 输入框 `@` 标签页 source（`lib/client.js` + `/api/browser-bridge/tabs`）
- [x] `browser_press` / `browser_scroll`
- [x] `ref` 生命周期与 stale 处理

## 测试

- [x] WS 单元测试
- [x] 配对/限速/CORS 测试
- [x] 桥 + 假扩展集成测试
- [x] Host 缓冲/格式化测试
- [x] 插件 apply 生命周期测试
- [x] 工具 schema 子集校验
- [x] 扩展静态检查（manifest、node --check、协议版本）
- [x] 真实 Chrome 端到端（临时 profile，41 tests + 手工工具矩阵）
- [x] Edge 冒烟（Edge 157，同一份扩展目录）
- [x] 自动配对实测（隔离 47830 桥，扩展无 token 启动 → 自动领取 64 hex token → 连接）
- [x] `@` 标签页 source 单测 + Host 路由实测（返回 Edge 当前 tabs）
- [x] 网页 Origin 拒绝（WS upgrade 403）
- [x] MV3 service worker reload 后自动重连
- [x] CSP 页面 `CSP_BLOCKED` 实测（DOM 工具正常）
- [x] Edge 日常 profile 已连接当前桥（`browser_status` 显示 Edge 157）
- [ ] Chrome 日常 profile（已登录页面）实测
- [ ] MV3 service worker 自然回收（>1 分钟）后唤醒
- [ ] React/Vue 受控输入真实表单

## 安装与验证

- [x] 插件 bundle 可被 DSH profile 安装（link）
- [x] HMR 下启用并确认 `fiberPhase: active`
- [x] 临时 Chrome 加载扩展
- [x] 自动连接成功、13 个工具端到端
- [x] 文档补充实测结果

## 已知缺口（v0.1 接受）

- 截图只截可见视口；会激活目标标签。
- 点击/输入是 DOM 级事件，不是 trusted input。
- console/network 只观测注入之后的事件；不覆盖 WebSocket/SSE。
- Shadow DOM 不穿透；iframe 子 frame 只支持协议层 frameId，工具未暴露。
- `browser_eval` 受页面 CSP 限制。

## P3（后续）

- [ ] 侧栏 Browser Live 面板（DSH client 插件 API）
- [ ] 按站点授权（默认只读）
- [ ] `chrome.debugger` 可选模式（trusted input / 完整网络 / 整页截图）
- [x] `@` 菜单注入标签页（client source）
- [ ] 多客户端（多浏览器同时连接）路由
- [ ] Shadow DOM / iframe 支持
- [ ] 网络 body 独立异步事件的状态提示（“body 稍后到”）

## P4（后续）

- [ ] Firefox 适配（manifest + browser.* + 注入器）
- [ ] Safari 适配
- [ ] caps 驱动工具可见性
