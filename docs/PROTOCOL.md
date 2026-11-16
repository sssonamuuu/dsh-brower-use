---
description: "Wire protocol for DSH Browser Bridge: HTTP discovery/pairing, WebSocket handshake, commands, events, capabilities, errors, and limits."
kind: "protocol-reference"
---

# PROTOCOL — DSH Browser Bridge v1

协议版本：`1`。Host 和扩展都必须拒绝不兼容版本，不静默降级。

所有消息是 UTF-8 JSON 文本。WebSocket 端口默认 `47821`，Host 在 `47821..47830`
范围内选第一个可用端口；扩展按同一范围扫描。

## 1. HTTP（发现与自动配对）

### `GET /hello`

无鉴权，用于扩展找到正确的本地服务。

响应 `200`：

```json
{
  "app": "dsh-browser-bridge",
  "protocol": 1,
  "version": "0.1.1",
  "autoPair": true,
  "pairing": true,
  "port": 47821
}
```

- `autoPair: true`：扩展可以自动领取 token，无需用户输入配对码。
- `token` 字段是**条件返回**的：只有请求的 `Origin` 是 `chrome-extension://…`
  （或带 `x-dsh-bridge-client: auto` 头的本机客户端）才出现；普通网页 Origin 不返回。
- `pairing: false` 表示当前不允许**手动**配对（已有客户端 / 配对被禁用）。
- 端口不是 47821 时，`port` 是实际端口，扩展直接使用。

> 自动配对仍需要 token。`/hello` 的 CORS 只对扩展 Origin 放行，网页读不到 token；
> 这是「无感」而不是「无鉴权」。

### `POST /pair`（手动后备）

正常流程不需要它；只有自动配对失败时使用。

请求体：

```json
{ "code": "123456" }
```

成功 `200`：

```json
{ "ok": true, "token": "64 hex chars", "protocol": 1, "port": 47821, "serverVersion": "0.1.1" }
```

失败：

| 状态 | `error` | 含义 |
|---|---|---|
| 400 | `bad_request` | 不是合法 JSON / 缺 code |
| 401 | `bad_code` | 配对码错误 |
| 429 | `rate_limited` | 同一 IP 1 分钟内失败超过 5 次 |
| 403 | `pairing_disabled` | 配置关闭配对，或已有客户端且不允许重复配对 |

CORS：只有 `Origin: chrome-extension://…` 会收到
`Access-Control-Allow-Origin: <origin>`；网页 Origin 不发 CORS 头，浏览器会阻止读取。

### `GET /health`

本地诊断，无敏感信息：

```json
{ "ok": true, "protocol": 1, "clients": 1, "active": { "browser": "chromium", "brand": "Chrome", "version": "146" } }
```

### `GET /api/browser-bridge/tabs`（DSH Web Host 路由）

给 Web 输入框 `@` 菜单用，不在 bridge 端口上，而在 DSH Web Server 上（同源）：

```json
{
  "ok": true,
  "tabs": [
    { "id": 123, "windowId": 1, "index": 0, "title": "App", "url": "http://localhost:3000/", "active": true }
  ]
}
```

- 只允许同源请求（`Origin` 为空或等于 `Host`）或 `null`（桌面壳），其他 Origin 返回 `403`。
- 扩展未连接时返回 `503`，`error: "NO_CLIENT"`。
- 只读；不会操作标签页。

### 动作 `system.ping`

不碰任何 `chrome.*` API 的存活探针：

```json
{"type":"command","id":"c_1","action":"system.ping","params":{}}
{"type":"result","id":"c_1","ok":true,"data":{"pong":1770000000000,"version":"0.1.1","alive":true}}
```

用途：区分「扩展没连上」和「扩展 socket 在但 service worker 的 `chrome.*` 挂死」。
后者在 Edge 长时间运行 / 扩展热重载后出现过，表现为所有 `tabs.*` / `page.*` 超时但
console/network 事件仍在推送。

### 错误码 `EXTENSION_UNRESPONSIVE`

扩展侧给每条命令加了 watchdog（`tabs.*` 8s、`page.eval`/其它 20s）。超时后不等 Host
自己超时，直接回：

```json
{"type":"result","id":"c_9","ok":false,"error":{
  "code":"EXTENSION_UNRESPONSIVE",
  "message":"extension did not answer \"tabs.list\" within 8000ms — … Reload the extension at edge://extensions",
  "details":{"action":"tabs.list","deadlineMs":8000}}}
```

### `GET /ws?token=…`

WebSocket upgrade：

- 请求带 `Origin` 且不是 `chrome-extension://…` / `extension://…` /
  `moz-extension://…` → `403`，网页不能冒充 DSH。
- 无 `Origin` 视为本机进程（CLI/测试），允许，但仍需 token。
- token 不匹配返回 `401` 并销毁 socket。

## 2. WebSocket 握手

扩展连接成功后立即发送：

```json
{
  "type": "hello",
  "protocol": 1,
  "client": {
    "browser": "chromium",
    "brand": "Chrome",
    "browserVersion": "146.0.0.0",
    "extensionVersion": "0.1.1",
    "platform": "macOS",
    "caps": ["dom", "console", "network", "screenshot", "input", "frames", "tabs"]
  }
}
```

Host 校验 `protocol === 1`，回复：

```json
{
  "type": "hello_ok",
  "protocol": 1,
  "serverVersion": "0.1.1",
  "sessionId": "…",
  "heartbeatMs": 20000,
  "limits": { "maxCommandBytes": 8388608, "maxEventBytes": 262144 }
}
```

不兼容时回复 `{ "type": "hello_error", "error": "protocol_mismatch", "serverProtocol": 1 }`
并关闭连接。

## 3. 心跳

扩展每 `heartbeatMs`（默认 20s）发送：

```json
{ "type": "ping", "ts": 1730000000000 }
```

Host 回：

```json
{ "type": "pong", "ts": 1730000000000 }
```

Host 超过 `3 * heartbeatMs` 没收到任何消息则关闭连接；扩展在 `close` 后按
1s → 2s → 4s → 8s → 10s 退避重连。

## 4. 命令（Host → 扩展）

```json
{
  "type": "command",
  "id": "c_42",
  "action": "page.snapshot",
  "tabId": 123,
  "frameId": 0,
  "params": { "maxChars": 30000 }
}
```

- `id` 在 Host 进程内单调递增。
- `tabId` / `frameId` 可选；缺省由扩展解析为当前活动标签/主 frame。
- `params` 必须是 JSON 对象。

成功响应：

```json
{ "type": "result", "id": "c_42", "ok": true, "data": { } }
```

失败响应：

```json
{
  "type": "result",
  "id": "c_42",
  "ok": false,
  "error": { "code": "NO_TAB", "message": "no active tab", "details": {} }
}
```

错误码：

| code | 含义 |
|---|---|
| `NO_TAB` | 找不到 tab / tab 已关闭 |
| `NO_ACTIVE_TAB` | 没有活动标签页 |
| `RESTRICTED_PAGE` | `chrome://`、商店等不可注入页面 |
| `NO_RECEIVER` | 内容脚本未注入 / 页面已卸载 |
| `CAPABILITY_MISSING` | 扩展未声明该能力 |
| `UNSUPPORTED_ACTION` | 未知 action |
| `EVAL_ERROR` | 页面 JS 抛错 |
| `CSP_BLOCKED` | 页面 CSP 阻止 eval |
| `TIMEOUT` | 扩展执行超时 |
| `INTERNAL` | 未分类错误 |

### 4.1 Action 列表

| action | 能力 | 参数 | 返回 |
|---|---|---|---|
| `tabs.list` | `tabs` | `{}` | `{ tabs: TabInfo[] }` |
| `tabs.active` | `tabs` | `{}` | `{ tab: TabInfo }` |
| `tabs.activate` | `tabs` | `{ tabId }` | `{ tab }` |
| `tabs.open` | `tabs` | `{ url, active? }` | `{ tab }` |
| `tabs.close` | `tabs` | `{ tabId }` | `{ closed: true }` |
| `tabs.reload` | `tabs` | `{ tabId, bypassCache? }` | `{ reloaded: true }` |
| `tabs.back` / `tabs.forward` | `tabs` | `{ tabId }` | `{ ok: true }` |
| `page.snapshot` | `dom` | `{ maxChars?, includeText?, selector? }` | `Snapshot` |
| `page.read` | `dom` | `{ selector?, maxChars? }` | `{ url, title, text, truncated }` |
| `page.eval` | `dom` | `{ expression, awaitPromise? }` | `{ value, type }` |
| `page.click` | `input` | `{ ref?, selector?, text?, x?, y?, button?, clickCount?, waitMs? }` | `{ clicked, tag, text, url }` |
| `page.type` | `input` | `{ ref?, selector?, value, clear?, submit?, delayMs? }` | `{ typed, tag, submitted }` |
| `page.press` | `input` | `{ key, modifiers?, ref?, selector? }` | `{ pressed }` |
| `page.scroll` | `input` | `{ direction, amount?, ref?, selector? }` | `{ scrollX, scrollY }` |
| `page.wait` | `dom` | `{ for, value?, timeoutMs?, pollMs? }` | `{ matched, ref?, elapsedMs }` |
| `page.screenshot` | `screenshot` | `{ format?, quality?, activate? }` | `{ dataUrl, mimeType, width, height }` |

`TabInfo`：

```json
{
  "id": 123,
  "windowId": 1,
  "index": 0,
  "title": "Example",
  "url": "http://localhost:3000/",
  "active": true,
  "pinned": false,
  "status": "complete",
  "audible": false,
  "discarded": false
}
```

`Snapshot`：

```json
{
  "url": "http://localhost:3000/",
  "title": "Example",
  "viewport": { "width": 1440, "height": 900, "devicePixelRatio": 2 },
  "scroll": { "x": 0, "y": 420, "maxY": 2400 },
  "interactive": [
    { "ref": "e12", "role": "button", "name": "Save", "selector": "button.btn-primary", "disabled": false }
  ],
  "text": "…",
  "truncated": false
}
```

`ref` 只在同一 document 生命周期内有效；页面导航后重新快照。

## 5. 事件（扩展 → Host）

```json
{
  "type": "event",
  "event": "console",
  "tabId": 123,
  "frameId": 0,
  "seq": 17,
  "ts": 1730000000123,
  "data": { }
}
```

`seq` 由扩展在**每 tab** 维度递增；Host 按 `tabId` 维护 `nextSeq`。重连后扩展可继续使用
本地 seq，Host 允许跳号（只用于增量读取，不做连续性断言）。

### 事件类型

| event | data |
|---|---|
| `console` | `{ level, args: JsonValue[], text, stack?, url?, line? }` |
| `network.request` | `{ id, method, url, type, requestHeaders?, body? }` |
| `network.response` | `{ id, status, statusText, responseHeaders, mimeType, durationMs, fromCache? }` |
| `network.body` | `{ id, body, truncated, size }` |
| `network.error` | `{ id, message }` |
| `tab.updated` | `{ tabId, change: "url"|"title"|"status", tab?: TabInfo }` |
| `tab.removed` | `{ tabId }` |
| `tab.activated` | `{ tabId, windowId }` |
| `page.lifecycle` | `{ phase: "DOMContentLoaded"|"load", url, title }` |

限制：

- 单条事件 JSON ≤ 256KB；超长 body 截断并置 `truncated: true`。
- Host 每 tab 保留最近 2000 条 console、1000 条 network；单条响应体 ≤256KB。
- Host 不把事件写入 Session 日志，只留在内存。

## 6. 截图

`page.screenshot` 的 `dataUrl` 是 `data:image/png;base64,…`（或 JPEG）。
Host 解码后写入工作区：

```
<workspace>/.dsh-browser/screenshots/shot-<epoch>-<tabId>.png
```

工具结果返回绝对路径、宽高、字节数。模型用 `read_image` 读取。

## 7. 能力协商

`caps` 是字符串数组：

| cap | 含义 |
|---|---|
| `tabs` | 标签页管理 |
| `dom` | 快照、读正文、eval、等待 |
| `console` | console/error 事件 |
| `network` | fetch/XHR 事件 |
| `screenshot` | 可见视口截图 |
| `input` | 点击、输入、按键、滚动 |
| `frames` | 跨 frame 寻址（v1 仅主 frame） |
| `debugger` | 可选 CDP 深度模式（v0.1 未实现） |

Host 在调用前检查对应 cap；缺失时返回 `CAPABILITY_MISSING`，并在工具结果中说明
哪个浏览器/版本不支持。

## 8. 版本演进

- 破坏性变更：`protocol` +1，Host 拒绝旧版本。
- 新增 action/event：向后兼容，`caps` 里声明；旧 Host 不认识就忽略。
- 新增字段：忽略未知字段；不要依赖字段顺序。
- `id` 前缀：Host 用 `c_`；扩展事件不占用。