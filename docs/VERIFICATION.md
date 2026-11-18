---
description: "Verification record for DSH Browser Bridge v0.1: automated tests, DSH bundle activation, and a real Chrome end-to-end run."
kind: "verification-record"
---

# VERIFICATION — v0.1（2026-11-10，2026-11-13 复核）

环境：

- macOS，DSH Desktop 0.2.2-rc.1
- Chrome 146.0.7680.165（临时 profile，不碰用户日常浏览器）
- Node 24.16.0
- 桥：`127.0.0.1:47821`

## 1. 自动化测试

```bash
node --test packages/dsh-browser-bridge/test/*.test.js
```

结果：**41 tests / 41 pass / 0 fail**（约 4.2s）。

覆盖：

- WebSocket 握手、7/16/64 位长度、掩码帧、ping/pong、错误 token；
- `/hello` 自动 token 下发（扩展 Origin / 显式头 / 普通网页）、`/pair`（正确/错误/限速/CORS）、WebSocket Origin 拒绝、token 持久化、0600 权限；
- 命令往返、超时、断线 reject；
- console/network 事件缓冲、合并、过滤、截断；
- 13 个工具的参数校验、格式化、截图落盘；
- `@` 标签页 client source：候选过滤、onPick、codec 序列化；
- 插件 `apply` 的启动/工具注册/卸载、带未完成 WebSocket 的 `stop()` 不挂起；
- 扩展 manifest、协议版本、全部 JS `node --check`、icon PNG。

## 2. DSH bundle 激活

```text
plugin_manager install_bundle link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge
→ { stage: "enable", target: "dsh-browser-bridge", enabled: true, changed: true, application: "applied" }
```

验证：

```bash
lsof -nP -iTCP:47821 -sTCP:LISTEN
# DeepSeek ... TCP 127.0.0.1:47821 (LISTEN)

curl -s http://127.0.0.1:47821/hello
# {"app":"dsh-browser-bridge","protocol":1,"version":"0.1.0","port":47821,"pairing":true}

curl -s http://127.0.0.1:47821/health
# {"ok":true,"protocol":1,"clients":0,"active":null,...}
```

`plugin_manager list_plugins` 中：

```text
{"entryId":"include:browser-bridge","moduleName":"dsh-browser-bridge","enabled":true,"fiberPhase":"active","patchId":"browser-bridge"}
```

`browser_status` 工具可调用，返回桥监听地址和 `Auto-pair: enabled`。

## 3. 真实 Chrome 端到端

用 `scripts/e2e-chrome.mjs` 启动临时 Chrome：

- `--remote-debugging-pipe` + `--enable-unsafe-extension-debugging`；
- 通过 CDP `Extensions.loadUnpacked` 加载 `extension/`（Chrome 137+ 正式版
  已移除 `--load-extension` 命令行开关，见
  [Chromium 公告](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)）；
- 写入 token、重载扩展，扩展自动连上桥；
- 打开 `http://127.0.0.1:8099/` fixture 页面。

| 能力 | 实测结果 |
|---|---|
| 真实配对路径（后备） | options 页 → background `dsh/pair` → `POST /pair` → 存 token → WS；返回 `{ok:true,port:47821}` |
| `browser_status` | connected，显示 Chrome 146，caps 全量 |
| `browser_tabs` list | 列出 2 个 tab，active 正确 |
| `browser_snapshot` | 5 个交互元素，ref/name/value/selector 正确 |
| `browser_type` ref=e1 | 输入 `hello@example.com`，页面 `saved:hello@example.com` |
| `browser_click` ref/selector | Save、Fail request、Throw error、Show late element 均触发 |
| `browser_read` | 读回 `saved:hello@example.com` |
| `browser_eval` | 返回对象 `{title,email,count}`；Promise 返回 42；抛错返回 `Error: eval boom` |
| `browser_press` | 在 `#email` 上按 Enter，页面 keydown 监听收到 `Enter` |
| `browser_scroll` | 向下 400px，返回 `y=400 page height 2427` |
| `browser_console` | 捕获 uncaught Error + stack；手动 `console.error` 可见 |
| `browser_network` list | `GET http://127.0.0.1:8099/api/fail → 500 · 2ms · 37 B` |
| `browser_network` get | 响应头、`x-fixture`、JSON body 全部可见 |
| `browser_wait` selector | `#late.ready` 在 0ms 内匹配 |
| `browser_screenshot` | 2400x1778 PNG 落盘，`read_image` 正常看到页面 |
| `browser_tabs` reload | 刷新后继续可操作 |
| `browser_tabs` open/close/activate | 打开 `api/slow`、关闭、about:blank 与 fixture 之间切换均成功 |
| `browser_tabs` open 元数据 | 新建 tab 等待导航后返回 `"127.0.0.1:8099/api/slow"` + URL |
| MV3 SW reload | `chrome.runtime.reload()` 后扩展自动重连，console/screenshot 继续可用 |

截图：[fixture-screenshot.png](assets/fixture-screenshot.png)（临时 Chrome）。

## 3.1 Edge 157 冒烟

同一份 `extension/` 目录，换成 Edge 二进制并走真实配对：

```text
[e2e] extension loaded: pocacjjagheombngifkkipfegfaciang
[e2e] pair result: { ok: true, port: 47821, serverVersion: "0.1.0" }
[e2e] extension connected: { browser: "chromium", brand: "Edge", version: "157.0.0.0" }
```

- `browser_snapshot`：5 个交互元素，ref/name/value 正确；
- `browser_click` + `browser_console`：Edge 上同样捕获 `Uncaught Error: fixture boom`。

当前环境里，用户手动加载的 **Edge 157** 也已连上真实桥：

```text
Extension: connected
  - Edge 157.0.0.0 (chromium) · extension 0.1.0 · MacIntel
Auto-pair: enabled
```

## 3.2 自动配对（隔离 47830 桥）

为了不打扰已连接的 Edge，使用隔离桥验证「扩展启动时没有 token」：

```bash
# 测试桥
DSH_BRIDGE_STATE_DIR=/tmp/dsh-auto-bridge node scripts/dev-bridge.mjs --port 47830

# 临时扩展副本，DEFAULT_PORT 改成 47830
cp -R extension /tmp/dsh-ext-auto
# 修改 /tmp/dsh-ext-auto/shared/protocol.js DEFAULT_PORT = 47830

E2E_EXTENSION_PATH=/tmp/dsh-ext-auto \
DSH_BRIDGE_PORT=47830 \
E2E_BRIDGE_STATE=/tmp/dsh-auto-bridge/state.json \
CHROME_PROFILE=/tmp/dsh-chrome-auto \
node scripts/e2e-chrome.mjs --auto
```

结果：

```text
[e2e] auto-pair mode: waiting for the extension to discover the bridge and fetch a token…
[e2e] extension connected: {"browser":"chromium","brand":"Chrome","version":"146.0.0.0"}
[e2e] auto token stored: yes (64 hex)
```

没有输入任何配对码；`/hello` 对扩展 Origin 下发了 token，扩展存入
`chrome.storage.local` 并建立 WS。隔离桥 `/health` 显示 `clients: 1`。

## 3.3 `@` 标签页

- Host 路由 `GET http://127.0.0.1:56668/api/browser-bridge/tabs`（同源、无浏览器扩展
  Origin）在 Edge 已连接时返回真实 tabs：`{ ok:true, tabs:[…] }`；扩展断开时返回
  `503 NO_CLIENT`。
- `client.js` 单测：输入两枚 tab，`@` source 生成候选、按 query 过滤、`onPick` 插入引用、
  `codec.serialize` 生成模型文本 `@[标题](dsh-browser-tab:<id>?url=…)`；另有一例按宿主
  的「最早起点优先」规则做整篇文本归约，断言 prologue/引用/尾部三者无缝覆盖、散文不误伤、
  旧格式 `[Browser tab id=…]` 仍能匹配并保留其后的句子。
- chip 注册项（用与 Web loader 相同的方式物化 bundle 后核对）：规则
  `browser-tab(order 20)`、`browser-tab-legacy(order 21)`；渲染器同名两条；样式表注入 1 个
  `<style>`，仅含 `--dsw-alias-state-business-primary`、`--dsw-alias-state-business-tertiary`、
  `--dsw-alias-border-selected`、`--dsw-alias-state-error-primary`、`--dsw-radius-sm`。
- 用户实测确认：发送后的消息已显示为行内 chip（此前是源码文本）。
- 点击激活：Host 路由单测覆盖 403 跨源、405 非 POST、400 缺 tabId / 非法 body、
  503 `NO_CLIENT`（扩展未连接）；客户端单测覆盖点击 payload `{tabId}`、成功不置错、
  失败置错、有文本选区时不触发、Enter/Space 触发。底层 `tabs.activate` 由
  `tools.test.js` 的 FakeExtension 端到端覆盖，`/activate` 路由只是复用该命令。
- Host 路由在真实 Edge 上实测（宿主重启后）：`POST /activate {tabId:2142824295}` 返回
  `200 {"ok":true,…}`，`tabs` 的 active id 由 `2142824295` 切到 `2142824537` 再切回，
  证明焦点真的移动；跨源 `403`、GET `405`、缺 `tabId` `400` 与单测一致。
- **未验证**：页面内**点击 chip** 触发该路由这一段（同一 bundle 的 `serialize` 已由新格式
  文本证明在运行，但点击本身需要用户在真实消息里点一次）。
- `GET /api/browser-bridge/client-status` 返回：
  `{"ok":true,"hasService":true,"clientPath":"/Users/.../lib/client.js","error":null}`，
  说明 client bundle 已进入 DSH client-modules 图。
- UI 侧需要刷新 DSH 页面一次让新 client source 加载；输入 `@` 后应出现「浏览器标签页」分组。

## 3.4 CSP 页面

`http://127.0.0.1:8099/csp` 返回 `Content-Security-Policy: script-src 'self'`：

- `browser_eval` → `Error: CSP_BLOCKED: Evaluating a string as JavaScript violates...`；
- `browser_snapshot` → 正常工作（DOM 工具不受页面 CSP 影响）。

## 3.5 DSH 重启

DSH 进程重启后：

- `127.0.0.1:47821` 重新监听；
- `state.json` 的 token 保持不变，配对码轮换（`281665` → `867181`）；
- 扩展 token 未变，因此无需重新配对即可重连。

## 4. 本轮发现并修复

1. **相对 URL**：`fetch('/api/fail')` 的 network 记录一开始是相对路径。collector 现在用
   `new URL(url, location.href)` 归一化，Host 的 response 事件也会补全绝对 URL。
2. **console stack 噪音**：堆栈里出现扩展 collector 帧。现在过滤
   `content/collector.js` / `chrome-extension://` 帧。
3. **注入顺序**：manifest 中 relay 改为先于 collector，避免 `page.lifecycle` 首发丢失。
4. **重连竞态**：连接握手期间不再允许第二个 `connect()` 打开重复 WebSocket。
5. **`tabs.goBack/goForward`**：增加 callback/promise 双兼容封装。
6. **`pageEval` 语法错误**：补成 `async function`（`await` 之前不在 async 函数里，
   `node --check` 已纳入测试防止回归）。
7. **`tabs.open` 元数据为空**：新建 tab 立刻读取时常没有 title/url；现在等待 120ms
   后重新 `chrome.tabs.get`。

## 5. 尚未验证 / 已知风险

- **用户日常 Chrome profile**：本轮用临时 profile 验证；用户需手动加载扩展。
  Edge 日常 profile 已连接（见 3.1），Chrome 日常 profile 尚未实测。
- **MV3 service worker 被回收后的自动唤醒**：做了 `chrome.runtime.reload()` 实测
  （立即重连）；没有做 Chrome 自然回收 SW 后的 1 分钟以上挂起实测。
- **React/Vue 受控输入**：用 native setter + input/change 实现，fixture 未装 React；
  需要在一个真实 React 表单上点一次确认。
- **Shadow DOM / iframe 子 frame**：v0.1 只保证主 frame + 开放 DOM；Shadow DOM 选择器
  不穿透，跨 frame 需要显式 frameId（工具暂未暴露）。

## 6. 复现

```bash
# 1) 确保 DSH 插件运行、桥在 47821
# 2) 启动 fixture 页面
node scripts/fixture-server.mjs

# 3) 临时 Chrome + 自动加载扩展（会打开一个临时窗口，不影响日常 profile）
node scripts/e2e-chrome.mjs          # 写入 token 直连（快速回归）
node scripts/e2e-chrome.mjs --pair   # 走手动配对码 + /pair 后备路径
node scripts/e2e-chrome.mjs --auto   # 扩展零 token 启动，验证自动领取（配合 E2E_* 环境变量）

# 4) 另开终端，用 DSH 的 browser_* 工具操作这个临时 Chrome
# 5) Ctrl+C 结束脚本，临时 Chrome 关闭
```

> `scripts/e2e-chrome.mjs` 只用于开发验证；日常使用仍是
> `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。
