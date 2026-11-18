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
│  │ collector (MAIN world) │  │127.0.0.1│  │ 工具 + 事件缓冲 + 自动配对│  │
│  │ relay / background     │  │  token  │  └────────────────────────┘  │
│  └────────────────────────┘  │        │             │                  │
│  你当前的标签页、登录态、DevTools│        │             ▼                  │
└──────────────────────────────┘        │         模型 / Agent            │
                                        └──────────────────────────────┘
```

## 产品构成：两个产物，缺一不可

本产品由**两个独立发布、必须配合使用**的产物组成：

| 产物 | 标识 | 运行位置 | 获取方式 |
|---|---|---|---|
| DSH Host 插件 | `@sssonamuuu/dsh-browser-bridge` | DSH 宿主进程内的 Cordis 插件，提供 `browser_*` 工具和本机桥 | npm：<https://www.npmjs.com/package/@sssonamuuu/dsh-browser-bridge>；开发期可 `link:` 到 [`packages/dsh-browser-bridge`](packages/dsh-browser-bridge) |
| 浏览器扩展 | DSH Browser Bridge（CRX ID `nacbbfdhmahhdhbghahfogpljnegjdal`） | 你日常使用的 Chrome / Edge | Edge Add-ons：<https://microsoftedge.microsoft.com/addons/detail/nacbbfdhmahhdhbghahfogpljnegjdal>；或「加载已解压」本仓库 [`extension/`](extension/) |

**关联关系：**

- 两端通过 `127.0.0.1:47821-47830` 上的 WebSocket 通信，协议版本 `1`（见 [PROTOCOL](docs/PROTOCOL.md)）。
- **只装插件**：`browser_*` 工具在，但每次调用返回 `NO_CLIENT`——没有扩展来连桥。
- **只装扩展**：扩展扫描不到桥，工具栏状态 `OFF`——DSH 里根本没有这些工具。
- 两端版本号**独立演进**，只要求协议版本兼容：扩展 `0.1.1` + npm `0.1.2` 就是可用组合。
- 推荐顺序：先装插件（让桥监听 `47821`），再装/重载扩展（自动发现并配对）；反过来也能连上，只是扩展会先退避重试。

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
| 状态 | `browser_status` | 连接状态、浏览器、自动配对状态、排查信息 |
| 多浏览器 | 自动 | Edge、Chrome 等扩展可同时连接；`@` 按浏览器分组，工具按 tab 归属路由 |
| `@` 提标签页 | `@` 菜单 | 在输入框输入 `@`，按浏览器分组显示带 favicon 的标签页；选中后插入引用 chip，发送后仍是 chip（悬停看完整 URL，点击可切到那个标签页） |

## 快速开始

### 1. 安装 DSH 宿主插件

普通用户在 DSH 的 **Plugins → Add plugin** 里装：

```text
@sssonamuuu/dsh-browser-bridge@0.1.2
```

开发时用本地链接包：

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

**商店安装（普通用户）**：Edge Add-ons 打开
<https://microsoftedge.microsoft.com/addons/detail/nacbbfdhmahhdhbghahfogpljnegjdal>
（CRX ID `nacbbfdhmahhdhbghahfogpljnegjdal`），点「获取」。装好后它自动连本机桥，
不需要任何账号。

**开发版**：Chrome：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择
本仓库的 [`extension/`](extension/) 目录。Edge 同理，地址是 `edge://extensions`。
同一份目录可以直接被 Chrome / Edge / Brave / Arc / Vivaldi 加载。

> Chrome 137+ 正式版已移除 `--load-extension` 命令行开关，必须手动「加载已解压」；
> [Chromium 公告](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)。

### 3. 自动连接（通常无需操作）

1. 扩展加载后会自动扫描 `127.0.0.1:47821-47830`，找到 DSH bridge。
2. bridge 只对**扩展 Origin**（或带显式客户端头的本机进程）下发 token；网页 Origin 拿不到。
3. 扩展用 token 连上 WS，状态变绿 `ON`，就可以让我「看下当前页面的报错」了。
4. 在 DSH 输入框里输入 `@`，菜单里会出现「浏览器标签页」分组，选一个就能把当前 tab 作为上下文提到对话里。

**不需要输入配对码。** 配对码只保留为后备：如果自动连接失败（旧浏览器、扩展 Origin
被策略改掉等），在 DSH 里调用 `browser_status` 拿 6 位码，填到扩展 Options 里即可。

token 持久化在 `~/.dsh/browser-bridge/state.json`（0600），DSH 重启后扩展自动重连。

## 安全边界

- 桥只监听 `127.0.0.1`，不监听公网。
- WebSocket 必须带 token；token 只对 `chrome-extension://` Origin 或带 `x-dsh-bridge-client` 头的本机客户端下发，普通网页因 CORS 读不到。
- WS upgrade 会拒绝 `http(s)` 网页 Origin，网页不能冒充 DSH 指挥扩展。
- 配对码 6 位、5 次/分钟限速、每次宿主启动轮换，仅作为自动配对失败时的后备。
- 扩展本身拥有 `tabs` / `scripting` / `<all_urls>` 权限，能读所有站点；这是「看你已登录页面」
  的必要代价。不适合安装到不受信任的浏览器 profile。
- 不做云同步、不上传页面内容；所有数据只在 `127.0.0.1` 上走。

## 已知边界

- `console` / `network` 只能看到**扩展注入之后**发生的事件；注入前的历史日志拿不到。
- 点击使用 DOM `element.click()`（不可信事件）。React/Vue 绝大多数场景可用；需要真正的
  trusted input 或看完整 CDP Network 时，后续可接 `chrome.debugger`（会与 DevTools 互斥）。
- 截图只能截当前可见视口（`captureVisibleTab`），不是整页；会短暂激活目标标签页。
- Firefox / Safari 目前只有架构预留，没有实现。见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 发布

发布浏览器扩展和 DSH 插件见 [docs/PUBLISH.md](docs/PUBLISH.md)。

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
  options.html/js               自动连接、后备配对、token/端口
  popup.html/js                 状态与后备配对
packages/dsh-browser-bridge/    DSH Host 插件（@sssonamuuu/dsh-browser-bridge）
  lib/index.js                  cordis 插件入口 + 工具注册
  lib/bridge-server.js          HTTP + WebSocket 服务、自动配对、客户端管理
  lib/ws.js                     零依赖 WebSocket 服务端实现
  lib/browser-state.js          console / network 事件缓冲
  lib/tools.js                  模型工具定义与格式化
  lib/client.js                 Web 客户端 @ 标签页 source
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