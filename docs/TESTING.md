---
description: "Test strategy and manual acceptance matrix for DSH Browser Bridge, including protocol unit tests and real browser checks."
kind: "testing-guide"
---

# TESTING — 测试矩阵

## 1. 自动化（不需要浏览器）

```bash
node --test packages/dsh-browser-bridge/test/*.test.js
```

覆盖：

| 测试 | 内容 |
|---|---|
| `ws.test.js` | 握手 accept key、短/126/127 长度帧、掩码解码、分片、ping/pong、close |
| `bridge.test.js` | `/hello` 自动 token 下发、`/health`、网页 Origin 403、错误 token、配对/限速/`autoPair:false`、客户端注册 |
| `tools.test.js` | 工具参数校验、无客户端时的错误提示、截图落盘、console/network 格式化 |
| `state.test.js` | console 环形缓冲、network request/response/body 合并、截断 |
| `extension-static.test.js` | manifest JSON 合法、所有 JS `node --check`、协议版本一致、自动配对头 |

## 2. 桥 + 假扩展集成

`test/fake-extension.js` 用 Node 内置 `WebSocket` 模拟扩展，按 action 返回固定数据：

- 连接、hello、心跳、命令往返；
- 断线后重连；
- 命令超时；
- 事件推送后 Host 缓冲可读；
- 单条大响应截断。

## 3. 真浏览器手工验收

前置：DSH 已加载插件，扩展已连接（正常会自动连接）。

| # | 操作 | 预期 |
|---|---|---|
| 1 | `browser_status` | `connected: true`，显示 browser/brand/version、`Auto-pair: enabled` |
| 1b | 删除扩展 token 后重载扩展 | 无需输入配对码，自动领取 token 并连接 |
| 2 | 打开两个窗口各一个标签，`browser_tabs` | 列出两个，active 标记正确 |
| 3 | `browser_tabs {action:"activate"}` | 浏览器切到对应标签 |
| 4 | 打开一个 React 表单页，`browser_snapshot` | 输入框/按钮有 `ref` 和可读 name |
| 5 | `browser_click {ref}` | 按钮触发，页面响应 |
| 6 | `browser_type {ref, value}` | 受控输入框值更新，React state 变化 |
| 7 | `browser_press {key:"Enter"}` | 表单提交 / 搜索触发 |
| 8 | `browser_eval {expression:"document.title"}` | 返回标题 |
| 9 | `browser_eval {expression:"Promise.resolve(1)"}` | 返回 1 |
| 10 | `browser_console {level:"error"}` | 页面报错后有 message + stack |
| 11 | 触发一个 500 JSON 请求，`browser_network` | 状态码 500，body 是 JSON |
| 12 | `browser_wait {for:"selector", value:".loaded"}` | 元素出现后返回 |
| 13 | `browser_screenshot` | 返回 PNG 路径；`read_image` 能看到画面 |
| 14 | 关掉 DSH 再启动 | 扩展自动重连，无需重新配对 |
| 15 | 在扩展 Options 里 Forget token | 扩展自动重新发现并连接；若失败，工具返回 `NO_CLIENT` 和后备配对提示 |

## 4. 边界场景

- **受限页面**：`chrome://extensions` 上调用工具 → `RESTRICTED_PAGE`，不崩溃。
- **页面导航**：快照 → 点击导航 → 旧 `ref` 点击 → 明确报 `STALE_REF` 或重新定位。
- **Service Worker 回收**：放置 1 分钟后调用工具，扩展应被 alarm 唤醒并重连。
- **DevTools 打开**：console/network 采集仍然工作（collector 与 DevTools 不互斥）。
- **CSP 页面**：`browser_eval` 报 `CSP_BLOCKED`；DOM 工具正常。
- **大响应体**：返回 2MB JSON，`browser_network` 的 body 被截断并标记 `truncated`。
- **多个 DSH profile**：扩展通常连最先扫描到的 bridge；切换时在 Options 重置连接或指定端口。
- **中文/emoji**：console 参数、输入文本不乱码。

## 5. 兼容性矩阵

| 浏览器 | 加载 | 自动连接 | DOM | console/network | 截图 |
|---|---|---|---|---|---|
| Chrome 146 (macOS) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edge 157 (macOS) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brave | 理论上 | 理论上 | 理论上 | 理论上 | 理论上 |
| Firefox | 未实现 | - | - | - | - |

> 每次发版前至少跑一遍 Chrome + Edge；其它 Chromium 系按同代码路径处理。

## 6. 回归清单（改代码后）

1. `node --test` 全绿。
2. `node --check` 所有扩展 JS。
3. `browser_status` + `browser_tabs` + `browser_snapshot` 三连。
4. 在真实页面触发一次 error 和一次失败请求，确认 console/network 仍可见。
5. 改 `manifest.json` 后在 Chrome 和 Edge 各重载一次。