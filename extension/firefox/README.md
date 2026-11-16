---
description: "Firefox adapter plan for DSH Browser Bridge; not implemented in v0.1."
kind: "browser-adapter-plan"
---

# Firefox adapter (planned)

v0.1 只实现 Chromium。Firefox 的差异集中在这里：

1. **manifest**：`background.scripts` 事件页（MV2）或 `background.service_worker`
   兼容层；需要 `browser_specific_settings.gecko.id`。
2. **API**：`browser.*` promise 风格；需要一个 `chrome` shim，或把
   `background.js` 的 `chrome.*` 调用抽成 `platform/chromium.js` /
   `platform/firefox.js`。
3. **注入器**：`scripting.executeScript` 的 `world: "MAIN"` 在 Firefox 里的行为需要
   单独验证；旧 collector hook 已删除，Firefox 适配应优先实现 `chrome.debugger` 对应的 CDP 能力。
4. **深度模式**：`chrome.debugger` 对应 `browser.debugger`，协议不同，v0.1 不实现。
5. **能力声明**：握手时 `browser: "firefox"`、`caps` 只声明已验证的能力（例如先只给
   `tabs` + `dom` + `screenshot`，console/network 验证后再加）。

Host 侧不需要改：工具按 `caps` 裁决，命令统一 `tabId + frameId`。

## 目录约定

```
extension/
  shared/          协议常量与序列化（Firefox 可复用）
  content/         Chromium 注入器
  page-scripts.js  Chromium 注入函数（Firefox 需验证）
  firefox/         本目录：manifest + shim + 注入器
```

实现顺序建议：先 `tabs` + `snapshot` + `read` + `screenshot`，再 console，
最后 network。每一步在真实 Firefox 上跑 `docs/TESTING.md` 的矩阵。
