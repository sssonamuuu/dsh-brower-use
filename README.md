# DSH Browser Bridge

> **状态**：v0.1 已实现，在临时 Chrome 146 + Edge 157 上完成端到端验证；见 [验证记录](docs/VERIFICATION.md)。

让 DeepSeek Harness（DSH）在**你当前已经打开、已经登录**的 Chrome / Edge 标签页上做前端调试：
读页面、点元素、填表单、跑 JS、看 `console` 报错、看网络请求和响应体、截图。

不需要重启浏览器，不需要开调试端口，不需要复制 Cookie —— 因为扩展就装在你日常用的浏览器里。

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  你的 Chrome / Edge          │        │  DSH Host 进程                 │
│  ┌────────────────────────┐  │  WS    │  ┌────────────────────────┐  │
│  │ DSH Browser Bridge 扩展│◄─┼────────┼─►│ dsh-browser-bridge 插件 │  │
│  │ collector (MAIN world) │  │127.0.0.1│  │ 工具 + 事件缓冲 + 配对   │  │
│  │ relay / background     │  │  token  │  └────────────────────────┘  │
│  └────────────────────────┘  │        │             │                  │
│  你当前的标签页、登录态、DevTools│        │             ▼                  │
└──────────────────────────────┘        │         模型 / Agent            │
                                        └──────────────────────────────┘
```

## 现在能做什么

| 能力 | 工具 | 说明 |
|---|---|---|
| 看标签页 | `browser_tabs` | 列出 / 切换 / 打开 / 关闭 / 刷新 / 前进后退 |
| 看页面结构 | `browser_snapshot` | 可交互元素列表（带 `ref`）+ 页面文本 + 视口/滚动 |
| 读正文 | `browser_read` | 整页或 CSS selector 的 `innerText` |
| 截图 | `browser_screenshot` | 存为 PNG 文件，模型再用 `read_image` 看 |
| 点击 | `browser_click` | `ref` / `selector` / 可见文本 / 坐标 |
| 输入 | `browser_type` | 原生 setter + `input`/`change` 事件，支持回车提交 |
| 按键 | `browser_press` | 组合键（`Meta+A`、`Enter` 等） |
| 滚动 | `browser_scroll` | 页面或元素内滚动 |
| 执行 JS | `browser_eval` | 页面 MAIN world 里执行表达式/语句，支持 Promise |
| 看 console | `browser_console` | error / warn / info / log，带堆栈，可清空 |
| 看网络 | `browser_network` | 请求列表、headers、状态码、耗时、响应体（文本/JSON） |
| 等待 | `browser_wait` | 等 selector / 文本 / console 报错 / 网络空闲 |
| 状态 | `browser_status` | 连接状态、浏览器、配对码、排查信息 |

## 快速开始

### 1. 安装 DSH 宿主插件

```bash
# 在 DSH Web 里对我说「安装 browser bridge 插件」，或手动：
# 把本目录 link 进当前 profile
cd ~/.dsh/profiles/desktop
pnpm add link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge
```

然后把 `packages/dsh-browser-bridge/cordis.patch.yml` 里的行合并进 profile 的
`cordis.patch.yml`，或使用 DSH 的 Plugins 页面把它作为 bundle 启用。详见
[docs/INSTALL.md](docs/INSTALL.md)。

### 2. 加载浏览器扩展

Chrome：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择
本仓库的 [`extension/`](extension/) 目录。Edge 同理，地址是 `edge://extensions`。
同一份目录可以直接被 Chrome / Edge / Brave / Arc / Vivaldi 加载。

> Chrome 137+ 正式版已移除 `--load-extension` 命令行开关，必须手动「加载已解压」；
> [Chromium 公告](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)。

### 3. 配对

1. 在 DSH 里让我调用 `browser_status`，拿到 6 位配对码。
2. 点浏览器工具栏里的扩展图标 → 输入配对码 → Pair。
3. 扩展状态变成绿色 `ON`，就可以让我「看下当前页面的报错」了。

配对码每次 DSH 启动时轮换；token 持久化在 `~/.dsh/browser-bridge/state.json`（0600），
所以 DSH 重启后扩展会自动重连，不需要重新配对。

## 安全边界

- 桥只监听 `127.0.0.1`，不监听公网。
- WebSocket 必须带 token；token 只在配对成功时通过一次性配对码换取。
- 配对码 6 位、5 次/分钟限速、每次宿主启动轮换。
- 扩展本身拥有 `tabs` / `scripting` / `<all_urls>` 权限，能读所有站点；这是「看你已登录页面」
  的必要代价。不适合安装到不受信任的浏览器 profile。
- 不做云同步、不上传页面内容；所有数据只在 `127.0.0.1` 上走。

## 已知边界

- `console` / `network` 只能看到**扩展注入之后**发生的事件；注入前的历史日志拿不到。
- 点击使用 DOM `element.click()`（不可信事件）。React/Vue 绝大多数场景可用；需要真正的
  trusted input 或看完整 CDP Network 时，后续可接 `chrome.debugger`（会与 DevTools 互斥）。
- 截图只能截当前可见视口（`captureVisibleTab`），不是整页；会短暂激活目标标签页。
- Firefox / Safari 目前只有架构预留，没有实现。见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

- [计划与范围](docs/PLAN.md)
- [架构与浏览器兼容](docs/ARCHITECTURE.md)
- [协议](docs/PROTOCOL.md)
- [安装与排障](docs/INSTALL.md)
- [测试矩阵](docs/TESTING.md)
- [验证记录](docs/VERIFICATION.md)
- [TODO](docs/TODO.md) · [开发日志](docs/DEVLOG.md)

## 目录

```
extension/                      MV3 扩展（Chrome / Edge 共用）
  content/collector.js          MAIN world：console / fetch / XHR / 错误采集
  content/relay.js              ISOLATED world：把事件转给 background
  background.js                 WS 连接、重连、命令执行、tab 管理
  options.html/js               配对、token、端口配置
  popup.html/js                 状态与快捷配对
packages/dsh-browser-bridge/    DSH Host 插件
  lib/index.js                  cordis 插件入口 + 工具注册
  lib/bridge-server.js          HTTP + WebSocket 服务、配对、客户端管理
  lib/ws.js                     零依赖 WebSocket 服务端实现
  lib/browser-state.js          console / network 事件缓冲
  lib/tools.js                  模型工具定义与格式化
  test/                         node:test 单元 + 集成测试
docs/                           计划、协议、开发日志
scripts/                        独立调试脚本
```

## 开发

```bash
node --version   # >= 22
node --test packages/dsh-browser-bridge/test/*.test.js
node scripts/dev-bridge.mjs      # 单独启动桥，打印配对码，便于调试扩展
node scripts/fixture-server.mjs  # 本地测试页面 http://127.0.0.1:8099/
node scripts/e2e-chrome.mjs      # 临时 Chrome 自动加载扩展做端到端验证
```

## License

MIT