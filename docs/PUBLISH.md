# 发布指南

本仓库发布两个独立产物：

1. **浏览器扩展**：Chrome Web Store / Microsoft Edge Add-ons
2. **DSH Host 插件**：npm 包 `@sssonamuuu/dsh-browser-bridge`，可选发布插件市场索引

扩展和 Host 插件版本可以独立更新，但协议版本必须兼容（当前 `PROTOCOL_VERSION=1`）。

## 一、发布浏览器扩展

### 1. 发布前检查

- [ ] 更新 `extension/manifest.json` 的 `version`
- [ ] 运行 `node --test packages/dsh-browser-bridge/test/*.test.js`
- [ ] 确认 `extension/icons/` 有 16/32/48/128 PNG
- [ ] 准备隐私政策页面（可放仓库 `docs/PRIVACY.md` 或 GitHub Pages）
- [ ] 确认 Firefox 仍未适配：`extension/firefox/README.md` 只是计划

当前扩展权限是：

```text
debugger, tabs, scripting, storage, alarms
host_permissions: http://127.0.0.1/*, http://localhost/*, <all_urls>
```

`debugger` 仅用于用户通过 `@` 明确选择标签页后按需 attach，30 秒无操作自动 detach；商店审核需要说明这一点。

商店审核重点是 `<all_urls>` 和读取页面内容的用途。商品页需要明确写：

> 仅用于连接本机 DSH，读取用户主动打开的页面 DOM、控制台和网络请求，不向远程服务器上传页面内容。

### 2. 打包

```bash
./scripts/package-extension.sh
```

生成：

```text
dist/dsh-browser-bridge-<version>-chromium.zip
```

> 不要上传整个仓库 zip；zip 根目录必须直接包含 `manifest.json`。

### 3. Chrome Web Store

1. 打开 <https://chrome.google.com/webstore/devconsole>
2. 注册 Chrome Web Store 开发者账号（通常一次性 $5）
3. **New item** → 上传 `dist/*-chromium.zip`
4. 填写商店信息：
   - 名称、简短描述、详细描述
   - 分类：Developer Tools
   - 图标：128×128
   - 截图：1280×800 或 640×400，至少 1 张
   - 隐私政策 URL
   - 权限用途说明
5. 在 Privacy practices 中声明：
   - 会读取网站内容（DOM / console / network）
   - 不会出售数据、不会向第三方上传页面内容
6. 提交审核

更新版本时：修改 `manifest.json` 版本 → `./scripts/package-extension.sh` → 在同一个 item 上传新版本。不要新建 item。

### 4. Microsoft Edge Add-ons

1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge/overview>
2. 注册 Microsoft 合作伙伴账号（免费）
3. **New extension** → 上传同一个 zip
4. 填写与 Chrome 相同的商店信息、隐私政策、截图
5. 提交审核

Chrome 和 Edge 共用同一份 Chromium 包。

### 5. 内部/团队安装

不经过商店时：

1. 用户下载 zip 并解压
2. 打开 `chrome://extensions` 或 `edge://extensions`
3. 开启开发者模式
4. **加载已解压的扩展程序** → 选择解压目录
5. 更新代码后点扩展卡片上的 **Reload**

### 6. Firefox

当前 `extension/` 是 Chromium MV3，不能直接发 AMO。需要先实现 `extension/firefox/README.md` 里的适配层：
- `browser.*` API shim
- 注入器差异
- `browser_specific_settings.gecko.id`
- 重新验证 console / network

## 二、发布 DSH Host 插件

包目录：

```text
packages/dsh-browser-bridge
```

包名：

```text
@sssonamuuu/dsh-browser-bridge
```

`package.json` 已经包含：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-input-trigger"] }
  }
}
```

`cordis.patch.yml` 必须使用同一个包名：

```yaml
- insert:
    - id: browser-bridge
      name: '@sssonamuuu/dsh-browser-bridge'
```

### 1. 发布前检查

```bash
cd packages/dsh-browser-bridge
npm pack --dry-run
```

确认打包列表包含：

- `lib/**/*.js`（包括 `lib/client.js`）
- `cordis.patch.yml`
- `locale/en.json`、`locale/zh.json`
- `docs/DETAIL.md`
- `icon.png`
- `README.md`

### 2. 发布到 npm

```bash
cd packages/dsh-browser-bridge
npm login
npm publish --access public
```

> 首次发布前确认 npm 账号 `sssonamuuu` 有 `@sssonamuuu` scope；如果是新 scope，先在 npm 创建组织或使用个人 scope。

### 3. 用户安装方式

DSH → **Plugins → Add plugin**：

```text
@sssonamuuu/dsh-browser-bridge@0.1.2
```

或在 Agent 中使用：

```text
plugin_manager install_bundle target=@sssonamuuu/dsh-browser-bridge@0.1.2
```

也可以直接从 Git 安装（适合未发 npm 的预发布）：

```text
git+https://github.com/sssonamuuu/dsh-brower-use.git#<40位commit>&path:/packages/dsh-browser-bridge
```

本地开发安装：

```text
link:/Users/liaoqingsong/Github/dsh-brower-use/packages/dsh-browser-bridge
```

### 4. 发布到插件市场 Discover（可选）

DSH 默认没有第三方插件索引。要出现在 Discover：

1. 把 npm 包发布好
2. 在公网 HTTPS 托管 `index.json`
3. 用户在插件市场设置里添加索引 URL

最小索引：

```json
{
  "format": 1,
  "title": {
    "en": "DSH Browser Bridge",
    "zh": "DSH 浏览器桥"
  },
  "plugins": [
    {
      "name": "@sssonamuuu/dsh-browser-bridge",
      "title": {
        "en": "DSH Browser Bridge",
        "zh": "DSH 浏览器桥"
      },
      "description": {
        "en": "Inspect and debug real Chrome/Edge tabs from DSH.",
        "zh": "在 DSH 中检查和调试真实 Chrome/Edge 标签页。"
      },
      "author": "sssonamuuu",
      "homepage": "https://github.com/sssonamuuu/dsh-brower-use",
      "repository": {
        "url": "https://github.com/sssonamuuu/dsh-brower-use",
        "directory": "packages/dsh-browser-bridge"
      },
      "metadata": {
        "keywords": ["browser", "devtools", "chrome", "edge"]
      },
      "versions": [
        {
          "version": "0.1.2",
          "publishTimestamp": 1760000000,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.2-rc.1" }
        }
      ]
    }
  ]
}
```

`publishTimestamp` 使用 npm 发布时的 Unix 秒时间。发布前用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex()` 校验。

## 三、GitHub Release

发布 tag 和附件也能作为团队分发渠道：

```bash
git tag v0.1.2
git push origin v0.1.2
```

在 GitHub Release 上传：

- `dist/dsh-browser-bridge-0.1.2-chromium.zip`
- `npm pack` 得到的 `sssonamuuu-dsh-browser-bridge-0.1.2.tgz`

## 四、常见失败

- **Chrome 提示 manifest 不在根目录**：重新用 `scripts/package-extension.sh`，不要在 zip 外层再套目录
- **DSH 插件显示技术名/默认图标**：检查 `locale/*.json`、`icon.png`、`exports`、`files` 是否被 `npm pack` 包含
- **安装后插件不加载**：确认 `cordis.patch.yml` 的 `name` 与 `package.json.name` 完全一致
- **商店拒绝 `<all_urls>`**：补充权限用途说明；如果仍被拒，考虑企业内部分发或改为按需授权
