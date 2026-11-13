---
description: "Installation and troubleshooting guide for the DSH Browser Bridge host plugin and the Chrome/Edge MV3 extension."
kind: "install-guide"
---

# INSTALL — 安装与排障

## 0. 前置条件

- DSH Desktop / Web 0.2.x（本仓库在 0.2.2-rc.1 上开发）。
- Chrome / Edge 111+（需要 `content_scripts[].world`）。
- Node 22+（仅开发/测试需要；日常使用不需要 Node）。
- DSH profile 可用 `pnpm`。

## 1. 安装 Host 插件

### 方式 A：作为链接包安装（开发推荐）

```bash
# 1) 让 profile 依赖本地的包
cd ~/.dsh/profiles/desktop
pnpm add link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge

# 2) 在 profile 的 cordis.patch.yml 追加行（或让 DSH 的 Plugins 页面启用 bundle）
cat >> cordis.patch.yml <<'YAML'
- id: browser-bridge
  name: dsh-browser-bridge
  config:
    port: 47821
    portRange: 10
YAML
```

> 注意：`cordis.patch.yml` 是 YAML 数组，直接 append 时要确保前面没有别的顶层结构冲突。
> 更稳的做法是编辑文件，在数组末尾加这一项。

### 方式 B：从 DSH 里安装（推荐，已实测）

在 DSH 里让 Agent 调用：

```
plugin_manager install_bundle  target=link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge
```

返回 `application: applied` 即已热加载；`plugin_manager list_plugins` 应出现：

```
{ "entryId": "include:browser-bridge", "moduleName": "dsh-browser-bridge", "enabled": true, "fiberPhase": "active" }
```

验证桥：

```bash
lsof -nP -iTCP:47821 -sTCP:LISTEN
curl -s http://127.0.0.1:47821/hello
```

> 这是本机开发用的 `link:` 安装；改 Host 侧 `packages/.../lib` 后需要重载插件或重启 DSH。
> 扩展侧改完后在 `chrome://extensions` 刷新扩展即可。

### 方式 C：只做协议/工具调试（不装插件）

```bash
node scripts/dev-bridge.mjs
```

它会单独启动桥，打印端口、token 和配对码，适合先验证扩展通路。

## 2. 加载扩展

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」。
4. 选择本仓库的 `extension/` 目录（不是 `extension/content/`）。
5. 固定到工具栏，方便看状态。

Chrome / Edge / Brave / Arc / Vivaldi 用**同一个目录**，不需要改代码。

> **Chrome 137+ 正式版移除了 `--load-extension` 命令行开关**，所以不要用命令行
> 自动加载；必须像上面这样手动「加载已解压的扩展程序」。Edge 同源策略仍以开发者模式
> 手动加载为准。Chromium 公告见
> [这里](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)。

## 3. 配对

1. 在 DSH 里调用 `browser_status`，或看 DSH Host 日志：
   `[browser-bridge] listening on ws://127.0.0.1:47821 pair=123456`。
2. 点扩展图标 → 输入 6 位配对码 → **Pair**。
3. 扩展弹出授权提示时确认（不同浏览器版本文案不同）。
4. 状态变成绿色 `ON`。

配对成功后 token 存在 `chrome.storage.local`；Host 重启后扩展会自动重连。

## 4. 验证

在 DSH 里说：

> 看下我当前打开的页面，列出可交互元素，然后读一下 console 有没有报错。

或者直接调用：

```
browser_status
browser_tabs  {}
browser_snapshot  {}
browser_console  { "level": "error", "limit": 20 }
```

## 5. 端口 / 多实例

- 默认 `47821`，被占用时自动尝试 `47822..47830`。
- 扩展扫描同一范围，找到 `/hello` 返回 `app: "dsh-browser-bridge"` 的端口。
- 同时开两个 DSH profile 时，扩展只会连第一个配对成功的；要切换，在扩展 Options 里
  **Forget token** 后重新配对。

## 6. 排障

### 扩展显示 `OFF`

1. 确认 DSH 插件已启用：`browser_status` 能返回 `listening: true`。
2. 确认没有别的进程占用端口：`lsof -nP -iTCP:47821 -sTCP:LISTEN`。
3. 点扩展 Options → **Test**，它会扫描端口并显示 `/hello` 结果。
4. 如果 `/hello` 正常但 WS 连不上：token 不对，Forget token 后重新配对。

### 工具报 `NO_CLIENT` / `NO_BRIDGE`

- 扩展没连上。先看扩展 badge；按上面的步骤重连。
- Host 刚启动时扩展可能还在退避重连，等 10 秒再试。

### `RESTRICTED_PAGE`

`chrome://`、`edge://`、Chrome Web Store、扩展页面无法注入。换普通 http(s) 页面。

### `NO_RECEIVER`

页面在扩展加载前就打开了，或者页面是受限页面。扩展连接时会补注入已有 tab；
如果仍失败，刷新页面再试。

### console 看不到历史日志

collector 是 `document_start` 注入的，但只记录**注入之后**的事件。刷新页面可以拿到
从页面启动开始的日志。

### `CSP_BLOCKED` / eval 失败

页面 CSP 禁止 `eval`。`browser_eval` 需要页面允许 `unsafe-eval`。开发环境通常没问题；
生产站点可以改用点击/输入/读取，或等 P3 的 `chrome.debugger` 模式。

### 截图是全黑 / 只截到一部分

`captureVisibleTab` 只能截**当前可见视口**，且会激活目标标签页。滚动到目标位置后再截，
或者用 `browser_scroll` + 多次截图。

### 点击没反应

DOM `click()` 是 untrusted 事件。少数依赖 `isTrusted` 的组件不响应。可以：
- 先 `browser_snapshot` 拿 `ref`，确认点的是对的元素；
- 用 `browser_eval` 直接调用组件暴露的方法；
- 等 P3 的 trusted input。

### 扩展更新后没生效

在 `chrome://extensions` 点扩展卡片上的刷新按钮；改了 `background.js` 必须刷新扩展，
content script 改动还需要刷新页面。

## 7. 卸载

1. 扩展：`chrome://extensions` → 移除。
2. Host 插件：Plugins 页面关闭 / 移除 bundle，或从 profile 的 `cordis.patch.yml` 删除
   `browser-bridge` 行并 `pnpm remove dsh-browser-bridge`。
3. 可选：删除 `~/.dsh/browser-bridge/state.json` 和 `<workspace>/.dsh-browser/`。