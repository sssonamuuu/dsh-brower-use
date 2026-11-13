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

## 自动连接

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

- `content/collector.js`（MAIN world）：在 `document_start` hook
  `console`、`window.onerror`、`unhandledrejection`、`fetch`、XHR。
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
