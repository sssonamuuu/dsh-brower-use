---
description: "Project plan for DSH Browser Bridge: objectives, phases P0-P4, acceptance criteria, risks, and explicit non-goals."
kind: "project-plan"
---

# PLAN — DSH Browser Bridge

## 1. 问题

前端开发在调试时经常需要 Agent 看当前页面：

- 页面是 `localhost:3000`，但登录 Cookie、LocalStorage、SSO 会话都在用户日常浏览器里；
- 新开一个 Playwright/无痕窗口会丢登录态，重新登录成本高，还可能触发风控；
- 用户已经开了 DevTools，希望 Agent 能看 console 报错、失败请求、响应体，而不是让用户复制粘贴。

现成方案的缺口：

- `browser-use --remote-debugging-port`：Chrome 136+ 默认 profile 忽略调试端口；换
  `--user-data-dir` 会丢掉现有标签和登录态。
- `dsh-browser-live` 一类第三方插件：有桥和截图，但没有 console / network 采集。
- 截图 + 鼠标键盘的 CUA：能操作，但读不到结构化报错和网络数据，调试效率低。

## 2. 目标

构建一个 **DSH Host 插件 + 浏览器扩展** 的组合，使模型可以：

1. 列出并定位用户当前打开的标签页（包括已登录页面）。
2. 读取页面结构、正文、可交互元素，并用稳定 `ref` 点击/输入。
3. 在页面 MAIN world 执行 JS（读取应用内部状态、调用已有全局函数）。
4. 获取注入之后的 `console` / 未捕获异常 / `fetch`+XHR 请求与响应体。
5. 截图并保存成文件，模型用 `read_image` 查看。
6. 等待某个 selector、文本、报错或网络空闲后再继续。

非目标（Non-goals）：

- 不做云端的浏览器农场，不远程控制别人的浏览器。
- 不绕过网站的人机验证、付费墙或风控。
- v0.1 不做 Firefox/Safari 的实际适配，只保留协议与目录结构。
- v0.1 不做多用户共享、不做跨机器连接。

## 3. 架构决策摘要

| # | 决策 | 理由 |
|---|---|---|
| D1 | 浏览器扩展 + 本地 WS 桥，不用 CDP 端口 | 保留现有标签/登录态；Chrome 136+ 限制调试端口；扩展可长期驻留 |
| D2 | WS 服务在 Host 侧，扩展主动外连 | 扩展不能监听端口；Host 可绑定 127.0.0.1 并统一鉴权 |
| D3 | 自动配对：扩展 Origin 领 token，配对码仅后备 | 用户零操作；网页 Origin 既读不到 token 也过不了 WS Origin 检查 |
| D4 | console/network 用 MAIN world 注入采集 | 隔离世界改 `console` 抓不到页面日志；MAIN world 可靠且可与 DevTools 并存 |
| D5 | 命令走 `tabId + frameId` 统一寻址，握手带 caps | Host 不写浏览器分支；后续 Firefox/Safari 只实现扩展侧 |
| D6 | Host 侧做事件缓冲 | 工具查询是同步读取；扩展休眠/重连不丢最近的报错 |
| D7 | 截图落盘返回路径 | DSH 工具结果目前以文本为主；`read_image` 可看本地 PNG |
| D8 | 快照生成 `ref` | 比让模型每次拼 CSS selector 稳定、省 token |

## 4. 阶段

### P0 — 文档与骨架（本次）

- 文档：README / PLAN / ARCHITECTURE / PROTOCOL / INSTALL / TESTING / TODO / DEVLOG。
- 目录：`extension/`、`packages/dsh-browser-bridge/`、`scripts/`。
- 验收：文档能指导一个没参与的人完成安装和排障。

### P1 — 通路与基础工具（v0.1 必须）

- Host：HTTP `/hello` `/pair` `/health`、WS `/ws`、token、单客户端管理、命令超时。
- 扩展：MV3 骨架、自动发现端口、自动领 token、断线重连、心跳、tab 管理。
- 工具：`browser_status`、`browser_tabs`、`browser_snapshot`、`browser_read`、
  `browser_click`、`browser_type`、`browser_eval`、`browser_screenshot`。
- 验收：在真实 Chrome 里对 `localhost` 页面完成「列 tab → 快照 → 点按钮 → 输入 → 截图」。

### P2 — 前端调试能力（v0.1 必须）

- collector：console 四级别、`window.onerror`、`unhandledrejection`、fetch、XHR、请求/响应体。
- 工具：`browser_console`、`browser_network`、`browser_wait`、`browser_press`、`browser_scroll`。
- 验收：页面抛错后 `browser_console` 能看到 message + stack；失败请求能看到状态码和 JSON body。

### P3 — 体验与安全增强（v0.2）

- 侧栏「Browser Live」面板：实时画面 + 当前 tab 状态（需要 DSH client 插件 API）。
- 按站点授权（默认只读，点击/输入需显式允许）。
- `chrome.debugger` 可选模式：完整 CDP Network/Console、trusted input；与 DevTools 互斥时明确提示。
- `@` 菜单注入当前标签页（需要 DSH `@` 来源 API，当前版本未公开稳定接口）。

### P4 — 多浏览器（v0.3+）

- Firefox：事件页 manifest、`browser.*` promise 封装、MAIN world 注入器验证。
- Safari：`safari-web-extension-converter` + 签名，最后做。
- 能力声明驱动工具可见性：不支持的浏览器不暴露对应工具。

## 5. 验收标准（v0.1）

**功能**

- [ ] 扩展能被 Chrome 和 Edge 从同一目录加载。
- [ ] 宿主插件能被 DSH profile 作为 bundle 加载，工具出现在模型工具列表。
- [ ] 扩展加载后自动连接（无需配对码）；DSH 重启后自动重连。
- [ ] `browser_tabs` 能列出至少 2 个窗口的标签，并能切换。
- [ ] `browser_snapshot` 返回可交互元素和 `ref`；`browser_click` 能用 `ref` 点中。
- [ ] `browser_type` 对 React 受控输入框有效（原生 setter + input 事件）。
- [ ] `browser_eval` 能返回 `document.title` 和 Promise 结果。
- [ ] 页面 `console.error(new Error('boom'))` 后，`browser_console` 有 message/stack。
- [ ] `fetch('/api/fail')` 返回 500 JSON 后，`browser_network` 能看到状态码和 body。
- [ ] `browser_screenshot` 落盘，`read_image` 能打开。
- [ ] 断开扩展后，工具返回可操作的排障提示，不是裸 `ECONNREFUSED`。

**质量**

- [ ] `node --test` 全绿；WS 分帧/掩码/64 位长度有单测。
- [ ] 桥只 bind `127.0.0.1`；错误 token 被拒绝；网页 Origin 被拒；配对码限速。
- [ ] 所有扩展 JS 通过 `node --check`；manifest JSON 合法。
- [ ] 文档包含安装、自动连接/后备配对、排障、已知边界。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| MV3 service worker 被回收 | 工具调用「没反应」 | 心跳 + `chrome.alarms` 唤醒 + 重连退避 + 发送队列 |
| 页面 CSP 禁止 eval | `browser_eval` 失败 | 明确报错并提示可选 debugger 模式；dev 环境通常无 CSP |
| 注入时机晚 | 丢失早期 console | 文档说明；`document_start` 自动注入 + 连接后补注入已有 tab |
| 页面脚本伪造 postMessage | 污染事件缓冲 | relay 校验 `source` + 频道名；Host 侧限流、截断 |
| 大响应体撑爆内存 | Host 卡顿 | 单条 256KB、每 tab 1000 条、工具输出再截断 |
| 扩展权限过大 | 安全顾虑 | 自动 token + WS Origin 检查、文档明示；P3 加按站点授权 |
| Chrome 商店政策 | 无法上架 | 以「开发者模式加载」为主，不上架 |

## 7. 时间估算

| 阶段 | 估时 | 实际 |
|---|---|---|
| P0 文档 | 0.5h | 本次会话 |
| P1 通路 + 基础工具 | 2h | 本次会话 |
| P2 调试能力 | 1.5h | 本次会话 |
| 测试 + 安装验证 | 1h | 本次会话 |
| P3/P4 | 后续 | 未开始 |