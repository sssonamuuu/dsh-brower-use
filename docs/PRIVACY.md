# 隐私说明 / Privacy Policy

DSH Browser Bridge 是一个本地开发调试工具。

## 收集的数据

浏览器扩展在用户主动使用 DSH 调试时，会读取用户当前标签页的：

- 页面 DOM 和可见文本
- 控制台日志
- fetch / XHR 请求信息
- 当前视口截图

这些数据仅用于本次本地调试。

## 数据去向

- 所有数据通过 `127.0.0.1` 上的本地 WebSocket 桥发送给用户本机运行的 DSH 宿主进程。
- 不发送到任何远程服务器，不出售，不共享给第三方。
- 控制台和网络数据不写入磁盘；截图只保存到用户工作区的 `.dsh-browser/` 目录。
- 扩展 token 保存在浏览器本地存储；桥 token 保存在 `~/.dsh/browser-bridge/state.json`，权限为 `0600`。

## 权限用途

- `tabs`：列出和操作用户打开的标签页
- `scripting`：向用户主动调试的页面注入采集脚本
- `storage`：保存本地 bridge token 和端口
- `alarms`：保持 MV3 service worker 与本地桥的连接
- `<all_urls>`：读取用户已登录页面的 DOM、console、network，这是调试真实页面的必要条件

## 删除数据

用户可以通过卸载扩展、删除 `~/.dsh/browser-bridge/state.json` 或删除工作区 `.dsh-browser/` 来清除本地数据。

## 联系

仓库：https://github.com/sssonamuuu/dsh-brower-use
