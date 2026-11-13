---
description: "Architecture of DSH Browser Bridge: extension layers, host plugin, browser abstraction, security model, and why CDP is not the default."
kind: "project-architecture"
---

# ARCHITECTURE — DSH Browser Bridge

## 1. 三层结构

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (Chrome / Edge / Brave / Arc / Vivaldi …)           │
│                                                             │
│  MAIN world                        ISOLATED world            │
│  ┌───────────────────────┐        ┌───────────────────────┐  │
│  │ content/collector.js  │ post   │ content/relay.js      │  │
│  │ hook console/fetch/   │───────►│ 校验来源后转发         │  │
│  │ XHR/error，document_  │Message │                       │  │
│  │ start 注入             │        └──────────┬────────────┘  │
│  └───────────────────────┘                   │ runtime msg   │
│                                              ▼               │
│                                  ┌────────────────────────┐  │
│                                  │ background.js (SW)     │  │
│                                  │ WS 连接 / 命令执行 /    │  │
│                                  │ tab 管理 / 重连         │  │
│                                  └───────────┬────────────┘  │
└──────────────────────────────────────────────┼───────────────┘
                                               │ ws://127.0.0.1:47821
                                               │ ?token=…
┌──────────────────────────────────────────────▼───────────────┐
│ DSH Host                                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ bridge-server.js                                       │  │
│  │  HTTP /hello /pair /health + WS /ws + 自动配对/限速     │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │                                │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │ browser-state.js                                       │  │
│  │  console ring / network map / tab events / seq          │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │                                │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │ tools.js + index.js                                    │  │
│  │  browser_* 工具、格式化、systemPrompt 指引              │  │
│  └──────────────────────────┬─────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────┘
                              ▼
                         模型 / Agent
```

## 2. 为什么不用 `--remote-debugging-port`

Chrome 136 起，默认用户目录会忽略 `--remote-debugging-port`。要 attach 到「现在开着的这个
Chrome」，必须用独立 `--user-data-dir` 重启 —— 现有标签页和登录态就不在里面了。

扩展方案的优势：

- 登录 Cookie / LocalStorage / IndexedDB / SSO 全部原样保留。
- 不需要重启浏览器，不需要关 DevTools。
- 可以长期驻留，断线自动重连。
- 仍然能在页面 MAIN world 执行 JS、hook `console` / `fetch`。

代价：不是完整 CDP。没有 `Network.getResponseBody` 的底层能力，只能拿到 JS 层可见的数据；
没有 trusted input（DOM `click()` 产生的是 untrusted 事件）；截图只能截可见视口。

## 3. 扩展侧分层

| 文件 | world | 职责 | 为什么在这一层 |
|---|---|---|---|
| `content/collector.js` | MAIN | hook `console`、`window.onerror`、`unhandledrejection`、`fetch`、XHR | 隔离世界改 `console` 抓不到页面自己的日志 |
| `content/relay.js` | ISOLATED | 校验 `window.postMessage` 来源，转发到 background | MAIN 不能直接用 `chrome.runtime`；隔离世界是可信边界 |
| `background.js` | SW | WS、重连、命令路由、`scripting.executeScript`、tab 操作、截图 | 唯一能同时访问 `chrome.*` 和网络的地方 |
| `popup/options` | extension page | 自动连接、状态、后备配对/token/端口 | 用户操作界面 |

`background.js` 不把浏览器差异暴露给 Host：握手时只声明
`browser: "chromium"`、`brand`、`version`、`caps`。Host 永远不写 `if (browser === …)`。

## 4. 命令如何到页面

```
Host tool
  └─ browserBridge.command(action, params, {tabId})
       └─ WS {type:"command", id, action, params}
            └─ background.js
                 ├─ tabs.*   → chrome.tabs / chrome.windows
                 ├─ page.*   → chrome.scripting.executeScript({target:{tabId, frameIds?}, world})
                 └─ screenshot → chrome.tabs.captureVisibleTab
```

- `page.snapshot` / `page.read` / `page.click` / `page.type` / `page.press` / `page.scroll` /
  `page.wait` 在 **ISOLATED** world 执行：可以访问 DOM，复用 `window.__DSH_PAGE__.refs`，
  不受页面 CSP 的 `unsafe-eval` 影响。
- `page.eval` 在 **MAIN** world 执行：能读页面闭包外的全局变量、框架实例；但受页面 CSP 限制。
- 同一个 tab 的所有扩展脚本共享同一个 isolated world，所以 `ref` 在快照和点击之间有效。
- 页面导航后 isolated world 重建，`ref` 失效；快照会重新分配。

## 5. 事件如何到 Host

```
collector: console.error(...)
  → window.postMessage({__dsh:"dsh-browser-collector", type:"console", data:{…}}, "*")
  → relay: 校验 event.source === window && data.__dsh
  → chrome.runtime.sendMessage({type:"dsh/event", payload})
  → background: 用 sender.tab.id / sender.frameId 打戳，加 seq
  → WS {type:"event", event:"console", tabId, frameId, seq, ts, data}
  → Host browser-state: 每 tab 环形缓冲
  → browser_console / browser_network 同步读取
```

Host 侧缓冲的原因：

- 工具查询不需要再 round-trip，页面已经导航/关闭也能看到最近的错误。
- 扩展 SW 被回收、重连期间，Host 仍保留已收到的事件。
- 可以按 `seq` 做增量读取，模型不必每次拉全量。

## 6. 安全模型

| 层 | 措施 |
|---|---|
| 网络 | 只 listen `127.0.0.1`；不提供公网绑定 |
| 自动配对 | `/hello` 只对扩展 Origin 或带 `x-dsh-bridge-client` 头的本机客户端下发 token；网页 Origin 拿不到 token |
| WS Origin | WS upgrade 拒绝任何 `http(s)`/`null` Origin；网页不能冒充 DSH 指挥扩展 |
| Token | `~/.dsh/browser-bridge/state.json` 0600；WS 查询参数校验；不写日志 |
| 手动后备 | 6 位配对码、5 次/分钟/IP、每次启动轮换；仅在自动配对失败时使用 |
| 扩展 | 用户显式加载解压扩展；`<all_urls>` 是读已登录页面的必要权限 |
| 数据 | 不落盘 console/network；截图只落用户工作区的 `.dsh-browser/` |
| 生命周期 | 插件卸载时关闭 HTTP/WS、拒绝所有 pending 命令 |

### 6.1 为什么不是「完全无鉴权」

浏览器里的任意网页也能请求 `127.0.0.1`。如果 bridge 不区分谁在连，一个恶意页面就能：

1. 连上本地 WS，冒充 DSH 给扩展发 `page.eval` / `page.click`；
2. 读取用户的标签页、Cookie 所在页面内容。

所以「完全自动检测、不要 token」并不安全。自动配对把鉴权变成用户无感，而不是取消鉴权：

- **扩展**用自己的 `chrome-extension://` Origin 拿到 token；网页的 `http(s)` Origin
  既拿不到 token（CORS 只对扩展 Origin 放行），也过不了 WS 的 Origin 检查。
- **本机进程**（Node/CLI）没有 Origin，或用显式 `x-dsh-bridge-client: auto` 头；
  它本来就能读 `~/.dsh/browser-bridge/state.json`，属于同一信任层级。
- **恶意扩展**可以拿到 token，但它本来就有 `<all_urls>` 权限，不是这个桥能防的边界。

明确信任假设：**能读到 `state.json` 的本机进程已经拥有同等权限**。这不是防本机恶意软件的
方案，是防网页/局域网误连的方案。

## 7. 浏览器兼容策略

差异全部关在 `extension/` 的第三层：

```
extension/
  shared/            浏览器无关：协议常量、序列化、重连逻辑（可被各平台 import）
  content/           Chromium 的注入器（MAIN + ISOLATED）
  background.js      Chromium 适配器（chrome.* 回调 + promise）
  firefox/           未来：manifest + browser.* promise 封装 + 注入器
```

| 能力 | Chromium | Firefox | Safari |
|---|---|---|---|
| 扩展打包 | 一份 MV3 manifest | 事件页 `background.scripts` + `browser_specific_settings` | 转换 + Apple 签名 |
| 页面 DOM 操作 | `scripting.executeScript` | 同 API，promise 化 | 16.4+ 同 API |
| console/network | MAIN world 注入，可靠 | 注入器需单独验证 | 需单独验证 |
| 深度 CDP | `chrome.debugger` | 协议不同 | 基本没有 |
| 截图 | `captureVisibleTab` | 同 | 同 |

协议层已经做了三件事，后加浏览器不用动 Host：

1. 握手声明 `caps`（`dom` / `console` / `network` / `screenshot` / `input` / `frames` / `debugger`）。
2. 工具按能力裁决：不支持的能力返回明确 `CAPABILITY_MISSING`，而不是伪装成成功。
3. 所有命令统一 `tabId + frameId` 寻址，事件带单调 `seq`。

## 8. 为什么 Host 不抽象「浏览器驱动接口」

浏览器差异在扩展内部；Host 只认协议和能力。再包一层 `BrowserDriver` 只会把
`chrome.*` 的差异复制到 Host，增加没有收益的抽象。唯一保留的扩展点是：

- `caps` 能力表；
- `action` 命名空间（`tabs.*` / `page.*` / `debugger.*`）；
- 错误码 `UNSUPPORTED_ACTION` / `CAPABILITY_MISSING`。

## 9. 后续：`chrome.debugger` 可选模式

需要完整 CDP 时：

- attach `chrome.debugger`，使用 `Runtime.evaluate`（绕过 CSP）、`Page.captureScreenshot`（可整页）、
  `Input.dispatchMouseEvent`（trusted input）、`Network.getResponseBody`（完整响应体）。
- 标签页会出现「正在调试此浏览器」提示条。
- **与 DevTools 互斥**：用户开着 DevTools 时 attach 失败。
- 设计为 `browser_eval` / `browser_screenshot` / `browser_click` 的可选 `useDebugger` 参数，
  用完自动 detach；默认关闭。

## 10. 已知限制

- console/network 是「注入之后」的观测，不是浏览器历史。
- `fetch` 响应体只读文本类内容（JSON/HTML/JS/XML），且 ≤256KB；二进制不读。
- `XMLHttpRequest` 的 `responseType` 为 `blob`/`arraybuffer` 时不读 body。
- 点击/输入是 DOM 级模拟，不是 trusted input；少数依赖 `isTrusted` 或原生文件选择器的场景不支持。
- 截图会激活目标标签页；多窗口下会切换焦点。
- `chrome://`、扩展商店等受限页面无法注入。