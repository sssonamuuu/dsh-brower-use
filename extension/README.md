---
description: "The Chrome/Edge MV3 extension half of DSH Browser Bridge: loading, pairing, permissions, reloading, and troubleshooting."
kind: "extension-guide"
---

# DSH Browser Bridge Extension

一份 MV3 扩展，Chrome / Edge / Brave / Arc / Vivaldi 共用同一个目录。

## 加载

1. `chrome://extensions`（Edge：`edge://extensions`）。
2. 打开「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择本目录（`extension/`）。
4. 固定到工具栏。

> Chrome 137+ 的**正式版**已经移除了 `--load-extension` 命令行开关，
> 所以自动化脚本不能再用 `--load-extension` 加载；必须手动「加载已解压」。
> `scripts/e2e-chrome.mjs` 用的是 CDP `Extensions.loadUnpacked`（需要
> `--enable-unsafe-extension-debugging` + `--remote-debugging-pipe`），仅用于开发验证。

## 调试附加策略

默认**不会**在每个页面注入 collector，也不会自动 attach debugger。只有在 DSH 输入框用 `@` 选择某个标签页后，扩展才通过 `chrome.debugger` attach 到该标签页，浏览器会显示“正在调试此浏览器”提示。

- 捕获 console / network 使用 CDP（`Runtime.enable` / `Network.enable`），不修改页面原生 `console` / `fetch` / `XMLHttpRequest`
- 30 秒无操作后自动 detach；关闭标签页也会 detach
- `browser_snapshot` / `browser_read` / 点击 / 截图仍通过 `chrome.scripting` 工作，不依赖 debugger
- 页面启动时已经发生的 console / network 事件无法回溯，attach 后需刷新页面重新触发

## 自动连接## 自动连接

1. 扩展加载后自动扫描 `127.0.0.1:47821-47830`。
2. 找到 DSH bridge 后，bridge 只向扩展 Origin 下发 token（网页 Origin 拿不到）。
3. 扩展用 token 连 WS，状态变绿 `ON`。

**正常不需要配对码。** 只有自动连接失败时，才在 DSH 里调用 `browser_status`，把 6 位码
填到扩展 Options 作为后备。token 存在 `chrome.storage.local`；DSH 重启后自动重连。

## 权限

| 权限 | 用途 |
|---|---|
| `tabs` | 列出/切换/刷新标签页 |
| `scripting` | 注入快照、点击、输入、eval |
| `storage` | 保存 token / 端口 |
| `alarms` | MV3 service worker 保活 |
| `<all_urls>` | 在用户已登录页面上读取 DOM、console、network、截图 |

扩展不向任何远端发送数据；所有流量只到 `127.0.0.1`。

## 架构

- `content/collector.js`（MAIN world）：旧版 hook 采集器，保留为兼容代码；默认不注入。当前调试使用 `chrome.debugger` CDP。
- `content/relay.js`（ISOLATED world）：校验 `window.postMessage` 来源后转发给 background。
- `background.js`：WS 连接、端口扫描、配对、命令执行、tab 管理、重连。
- `page-scripts.js`：通过 `chrome.scripting.executeScript` 注入到页面的自包含函数。
- `popup.html` / `options.html`：状态、配对、token/端口配置。

## 改代码后

- 改 `background.js`、`manifest.json`、`page-scripts.js`、`popup/options`：
  在 `chrome://extensions` 点扩展卡片上的刷新按钮。
- 改 `content/*.js`：刷新扩展后还要**刷新目标页面**，否则旧 content script 仍在。
- 改 `page-scripts.js`：刷新扩展即可；下次命令会重新注入。
- 改 manifest 权限：扩展会提示重新授权。

## 排障

见 [../docs/INSTALL.md](../docs/INSTALL.md#6-排障)。

## Troubleshooting: connected but every command times out

If `browser_status` says the extension is connected while `browser_tabs` times out, the
service worker's `chrome.*` API has hung (seen after days of uptime or an extension
hot-reload). The WebSocket and the console/network buffers keep working, which makes it
look half-alive.

1. Run `browser_status` — since 0.1.1 it pings the worker and says so explicitly.
2. Open `edge://extensions` (or `chrome://extensions`) and click **Reload** on
   DSH Browser Bridge.
3. It reconnects on its own (auto-pair); no code is needed.

The extension also bounds every command (8s for `tabs.*`, 20s otherwise) and answers with
`EXTENSION_UNRESPONSIVE` instead of letting the Host time out silently.
