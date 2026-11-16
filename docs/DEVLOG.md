---
description: "Chronological development log for DSH Browser Bridge: decisions, implementation notes, verification output, and known issues."
kind: "development-log"
---

# DEVLOG — DSH Browser Bridge

> 记录「做了什么 / 为什么 / 怎么验证 / 还剩什么」。新条目追加在顶部。

## 2026-11-16 — 多浏览器标签按浏览器连续分组

- `@` 候选排序改为一组浏览器内的标签连续排列（组内 active 优先），
  这样同一个浏览器的分区标题只渲染一次，不会来回重复。
- 新增 client-source 测试断言同浏览器共享同一个 section 对象。

## 2026-11-16 — 支持 Edge/Chrome 同时连接

### 问题

同一设备安装 Edge 和 Chrome 两个扩展时，后连接的 hello 会关闭前一个连接，导致只剩一个浏览器。

### 实现

- hello 只替换同一 `browser|brand` 的旧连接，不同浏览器保留。
- 命令路由：`clientId` → tab 归属 → `browser` → 最近连接。
- `#tabOwners` 记录 tab 属于哪个浏览器；`bridge.listTabs()` 并行汇总所有客户端。
- `browser_tabs list` 和 `@` 路由使用合并后的 tabs，按浏览器分组展示。
- `browser_status` 显示已连接浏览器数量。

### 验证

43/43 tests pass，新增双 FakeExtension 测试：Edge/Chrome 同时连接、tabs 合并、
`page.read` 按 tabId 路由到正确浏览器。

---

## 2026-11-13 — 诊断「连上了但命令全超时」

### 现象

`@` 提到标签页后让 agent 读页面，`page.snapshot` / `page.read` / 甚至 `tabs.list` 全部
超时，但 `/health` 一直显示 `clients: 1`，console/network 计数还在涨。

### 结论

扩展的 WebSocket 与事件通道是活的（事件来自 content script → relay → SW），但
service worker 里的 `chrome.tabs.*` Promise 不 resolve：所有需要 tab 的命令都卡住，
而 console/network 读取走 Host 缓冲，所以看起来「半死不活」。

### 改动

1. 扩展侧每条命令加 watchdog：`tabs.*` 8s、默认 20s；超时先于 Host 返回
   `EXTENSION_UNRESPONSIVE`，并给出「重载扩展」的具体指引。
2. 新增 `system.ping` 动作，不碰任何 `chrome.*`，用来证明 SW 活着且能路由。
3. `browser_status` 主动 ping 一次：能答 → 正常；超时 → 直接输出
   「socket 在但命令不响应，请重载扩展」。
4. 静态测试锁定 watchdog 与 `system.ping` 不依赖 `chrome.*`。

### 验证

42/42 tests pass；真实环境仍需用户在 `edge://extensions` 重载一次扩展才能恢复命令通道。

---

## 2026-11-13 — 支持在输入框 @ 当前标签页

### 背景

用户问「插件装了，为什么还是不能 @ 我现在开着的 tab」。`browser_*` 工具只能让模型主动
去查，`@` 菜单需要单独的**客户端 source**，不在 Host 工具里。

### 实现

1. Host 增加同源只读路由 `GET /api/browser-bridge/tabs`，调用
   `bridge.command('tabs.list')`；只允许同源/`null` Origin，扩展未连接返回 503。
2. 包增加 client half `lib/client.js`（手写 `window.__ModuleLoader__.load` CJS factory），
   通过 `dsh.client` 声明加载，注册 `@` source `browser-tab`。
3. 候选：active 优先，显示标题、URL、窗口；选中插入
   `[Browser tab id=123] 标题 — URL`，模型据此调用 `browser_snapshot {tabId:123}`。
4. 无需构建：client.js 无 React/无 import，直接由 `dsh-client-modules` 提供。

### 验证

- 单测 `client-source.test.js`：候选过滤、`onPick`、`codec.serialize`。
- 真实 Host 路由：Edge 已连接时返回 tabs JSON；断开时 `503 NO_CLIENT`。
- `/api/browser-bridge/client-status` 显示 clientPath 已被 DSH client-modules 识别。
- 41/41 tests pass。

### 注意

- `@` source 属于 Web 客户端 bundle；**改完需要刷新 DSH 页面**（或等 client-modules HMR）
  才能加载新 source。
- 如果页面在桌面壳里，client bundle 通过 shell carrier 加载，不经过 `/plugins` HTTP 路由。

---

## 2026-11-13 — 去掉配对码：自动配对

### 背景

用户问「为什么非要配对码，直接检测本机 DSH 和扩展不行吗」。

配对码原本是为了挡网页：任意网页也能请求 `127.0.0.1`，如果 bridge 无鉴权，网页就能
冒充 DSH 给扩展发命令、读标签页内容。但让用户抄 6 位码确实是多余的一步。

### 方案

把鉴权自动化，而不是删掉鉴权：

1. `/hello` 对**扩展 Origin**（或带 `x-dsh-bridge-client: auto` 头的本机客户端）返回 token；
   普通 `http(s)` Origin 不返回 token，且 CORS 也不会放行其读取。
2. WS upgrade 拒绝任何非扩展 Origin（`http(s)` / `null`）；网页即使拿到 token 也连不上。
3. 扩展启动时扫描端口，自动领取 token 存 `chrome.storage.local`，直接连 WS。
4. 配对码保留为后备：`autoPair: false` 或自动握手失败时使用。
5. token 仍持久化在 `state.json` 0600；本机进程可读，属于同一信任层级。

### 验证

- 单测：`/hello` token 只给扩展/显式头；网页 Origin 拿不到；WS 网页 Origin 403；
  `autoPair:false` 不返回 token。
- 隔离桥 47830 + 临时扩展（`DEFAULT_PORT=47830`）+ 临时 Chrome：扩展**零 token 启动**，
  自动领取 64 hex token 并连接，`auto token stored: yes`。
- 真实桥 47821：用户手动加载的 Edge 157 已连接，`browser_status` 显示
  `Auto-pair: enabled`。
- 40/40 tests pass。

### 待办

- 用户 Chrome 日常 profile 手动加载扩展（无需配对）。
- 如果扩展仍显示 `OFF`：看 Options 的 Test/端口；必要时用 `browser_status` 的后备配对码。

---

## 2026-11-13 — 重启回归、Edge、SW reload、CSP

### 背景

DSH 应用重启（GUI URL 变化），需要确认：

- 插件仍能挂载、桥仍监听；
- token 持久化、配对码轮换；
- 上一轮修改后的扩展在 Chrome/Edge 上仍可用；
- HMR 卸载卡住的问题已经修掉。

### 结果

- 重启后 `127.0.0.1:47821` 正常监听；配对码从 `281665` 轮换成 `867181`，token 不变。
- 临时 Chrome 146 + 真实配对码 `dsh/pair` 路径通过。
- 同一份 `extension/` 在 Edge 157 上配对、snapshot、click、console 全部通过。
- 扩展 `chrome.runtime.reload()` 后自动重连；console 与 screenshot 继续工作。
- CSP 页面：`browser_eval` 返回 `CSP_BLOCKED`，`browser_snapshot` 正常。
- `browser_tabs open` 之前返回空 title/url；改为等待状态 `complete` 后返回。
- `bridge.stop()` 之前会等未完成 hello 的 WebSocket，导致 HMR `unloading` 卡住；
  现在跟踪所有 TCP socket，stop 时 destroy，并加 2s 上限；新增单测。

### 测试

- 37/37 pass（新增：未完成 hello 的 WebSocket stop 测试）。

### 待办

- 用户在**日常 Chrome** 手动加载扩展并配对（保留登录态）。
- React/Vue 受控输入真实表单。
- Chrome 自然回收 SW（>1 分钟）后的唤醒。

---

## 2026-11-10 — 端到端跑通（v0.1 完成）

### 安装

- `plugin_manager install_bundle link:.../packages/dsh-browser-bridge`
- 返回 `{ stage: "enable", changed: true, application: "applied" }`
- `include:browser-bridge` 在 `list_plugins` 中 `enabled: true, fiberPhase: active`
- 桥在 `127.0.0.1:47821` 监听，`/hello`、`/health` 正常。

### 端到端（临时 Chrome 146）

Chrome 137+ 正式版移除了 `--load-extension`，改用：

```
--enable-unsafe-extension-debugging --remote-debugging-pipe
CDP Extensions.loadUnpacked { path: extension/ }
```

写 token 到 `chrome.storage.local`，`chrome.runtime.reload()`，扩展自动连上桥。
fixture 页面验证结果见 [VERIFICATION.md](VERIFICATION.md)：

- tabs / snapshot / click / type / read / eval / console / network / wait / screenshot 全部通过；
- console 捕获 uncaught error + stack；
- network 捕获 500 + JSON body；
- 截图为 2400x1778 PNG，`read_image` 正常显示。

### 本轮修复

- 相对 URL 归一化（`new URL(url, location.href)`），network 记录显示绝对 URL；
- console stack 过滤扩展帧；
- relay 先于 collector 注入；
- 握手期间禁止重复 `connect()`；
- `tabs.goBack/goForward` 双兼容；
- `pageEval` 改为 `async function`（测试补上 `node --check` 覆盖）。

### 测试

- `node --test ...`：36/36 pass。
- 新增 `schema.test.js` 校验工具 schema 不超出 DSH 支持的 JSON Schema 子集。
- 新增 `scripts/fixture-server.mjs`、`scripts/e2e-chrome.mjs`。

### 待办

- 用户在**日常 Chrome** 手动加载扩展并配对（保留登录态）。
- Edge 冒烟；React 受控输入；MV3 SW 回收；CSP 页面。
- Host 侧代码改动需重载插件/重启 DSH；扩展改动在 chrome://extensions 刷新。

---

## 2026-11-10 — 项目启动（P0/P1/P2）

### 背景

用户是前端开发，需要在**已登录的当前浏览器标签页**上让 DSH 看报错、网络请求、操作页面。
上一轮会话确认的结论：不用 CDP attach（Chrome 136+ 默认 profile 忽略调试端口），
改用 MV3 扩展 + 本地 WS 桥。

### 决策

1. **Host 侧零运行时依赖**：自己实现最小 WebSocket 服务端，工具定义直接用 JSON Schema，
   不 import `@deepseek-ai/dsh-tools`（避免 linked package 的模块解析问题）。
   代价：失去 `defineTool` 的参数自动校验，改为工具内部显式校验。
2. **配对码 + 持久 token**：首次配对 6 位码，token 存 `~/.dsh/browser-bridge/state.json`；
   配对码每次启动轮换，token 持久化，DSH 重启自动重连。
3. **collector 放 MAIN world**：只有这里能 hook 页面自己的 `console` 和 `fetch`。
   relay 放 ISOLATED world，校验 `window.postMessage` 来源。
4. **Host 缓冲事件**：工具查询同步读内存；扩展休眠/重连不丢最近的报错。
5. **截图落盘**：当前 DSH 工具结果以文本为主，返回路径让模型用 `read_image` 看。

### 实现

- 写了 `extension/`：manifest、background、collector、relay、popup、options。
- 写了 `packages/dsh-browser-bridge/`：桥、WS、状态、工具、插件入口。
- 输出文档：PLAN / ARCHITECTURE / PROTOCOL / INSTALL / TESTING / TODO。

### 验证

- `node --test packages/dsh-browser-bridge/test/*.test.js` —— 见下条。
- `node --check` 全部扩展脚本。
- 真实浏览器验收：待用户加载扩展后执行。

### 待办 / 风险

- DSH profile 安装方式需要实测（link + patch）。
- Chrome 的 `captureVisibleTab` 需要 `activeTab`/`<all_urls>`，已在 manifest 配 `<all_urls>`。
- `browser_eval` 在 CSP 页面会失败，P3 再考虑 `chrome.debugger`。

---

## 模板

```
## YYYY-MM-DD — 标题

### 背景 / 决策 / 实现 / 验证 / 待办
```