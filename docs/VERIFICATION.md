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

结果：**37 tests / 37 pass / 0 fail**（约 4.2s）。

覆盖：

- WebSocket 握手、7/16/64 位长度、掩码帧、ping/pong、错误 token；
- `/hello`、`/pair`（正确/错误/限速/CORS）、token 持久化、0600 权限；
- 命令往返、超时、断线 reject；
- console/network 事件缓冲、合并、过滤、截断；
- 13 个工具的参数校验、格式化、截图落盘；
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

`browser_status` 工具可调用，返回桥监听地址和配对码。

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
| 真实配对路径 | options 页 → background `dsh/pair` → `POST /pair` → 存 token → WS；返回 `{ok:true,port:47821}` |
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

## 3.2 CSP 页面

`http://127.0.0.1:8099/csp` 返回 `Content-Security-Policy: script-src 'self'`：

- `browser_eval` → `Error: CSP_BLOCKED: Evaluating a string as JavaScript violates...`；
- `browser_snapshot` → 正常工作（DOM 工具不受页面 CSP 影响）。

## 3.3 DSH 重启

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

- **用户日常 Chrome profile**：本轮用临时 profile 验证；用户需手动加载扩展并配对。
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
node scripts/e2e-chrome.mjs --pair   # 走真实配对码 + /pair 路径

# 4) 另开终端，用 DSH 的 browser_* 工具操作这个临时 Chrome
# 5) Ctrl+C 结束脚本，临时 Chrome 关闭
```

> `scripts/e2e-chrome.mjs` 只用于开发验证；日常使用仍是
> `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。
