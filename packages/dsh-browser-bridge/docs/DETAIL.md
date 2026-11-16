# DSH 浏览器桥

让 DSH 直接检查和调试**本机已经打开、已经登录**的 Chrome / Edge 标签页，而不是另开一个没有登录态的新浏览器。

## 能力

- 查看页面 DOM、可交互元素、文本和当前视口
- 读取页面控制台日志（log / info / warn / error / debug）
- 查看 fetch / XHR 请求：状态码、耗时、请求头、响应头和响应体
- 截取当前可见区域
- 点击、输入、按键、滚动、等待元素/网络空闲
- Edge 和 Chrome 可以**同时连接**，按标签页归属路由命令
- 扩展连接时，需要网页查询可让 DSH 用 `browser_tabs action=open` 在用户现有浏览器窗口打开 tab，保留登录态，而不是使用无登录态的独立浏览器
- 在输入框输入 `@` 按浏览器分组列出标签页，并显示 favicon

## 安装

### 1. DSH 插件

在 DSH 的 **Plugins → Add plugin** 中安装：

```text
@sssonamuuu/dsh-browser-bridge
```

或从本仓库本地安装：

```text
link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge
```

### 2. 浏览器扩展

- Edge Add-ons：<https://microsoftedge.microsoft.com/addons/detail/nacbbfdhmahhdhbghahfogpljnegjdal>
  （CRX ID `nacbbfdhmahhdhbghahfogpljnegjdal`）
- 开发版：在浏览器扩展页「加载已解压」本仓库的 `extension/` 目录

两个产物必须同时安装：只装插件时工具返回 `NO_CLIENT`，只装扩展时状态 `OFF`。
两端版本号独立，只要求协议版本一致（当前 `1`）。

扩展会自动发现本机 DSH 桥并自动配对，不需要手动输入配对码。端口默认是 `47821`，会在 `47821..47830` 范围内自动探测。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `47821` | 首选端口 |
| `portRange` | `10` | 端口被占用时尝试的范围 |
| `stateDir` | `$DSH_HOME/browser-bridge` | token / 配对状态目录 |
| `heartbeatMs` | `20000` | 心跳间隔 |
| `commandTimeoutMs` | `15000` | 命令默认超时 |
| `maxConsole` | `2000` | 每个标签页保留的控制台条数 |
| `maxNetwork` | `1000` | 每个标签页保留的网络请求数 |
| `maxBodyBytes` | `262144` | 单个响应体截断上限 |

## 权限与安全

- 桥只监听 `127.0.0.1`，不绑定公网地址
- WebSocket 需要持久 token；token 文件权限 `0600`
- 自动配对只向扩展 Origin 或带本机证明头的客户端下发 token
- 扩展需要 `<all_urls>` 才能读取用户当前页面的 DOM / console / network，这是调试已登录页面的必要权限
- 默认不会自动注入采集器；只有在 DSH 输入框用 `@` 选择某个标签页后才 attach `chrome.debugger`，浏览器会显示“正在调试此浏览器”提示；30 秒无操作后自动 detach
- 控制台和网络通过 CDP 捕获，不修改页面原生 `console` / `fetch` / `XMLHttpRequest`；页面启动前已发生的事件无法回溯
- 插件不把 console / network 数据写入磁盘；截图只写到工作区 `.dsh-browser/`

## 限制

- 控制台和网络只记录扩展注入之后发生的事件；看页面启动请求需要先刷新页面
- 网络只覆盖 fetch / XHR，不覆盖 WebSocket、SSE
- 截图只截当前可见视口，不是整页长截图
- `edge://`、`chrome://` 等浏览器内部页面无法注入
- 不提供 Chrome DevTools 的断点、Performance、Memory 等能力

## 架构

```text
DSH Host 插件
  └─ 本机 HTTP/WS 桥 (127.0.0.1:47821)
        ▲
        │ WebSocket + token
        │
浏览器扩展
  ├─ MV3 service worker
  ├─ ISOLATED relay
  └─ MAIN-world collector / page actions
```

浏览器扩展和 Host 插件分开发布；Host 插件负责工具和桥，扩展负责连接真实浏览器标签页。
