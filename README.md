# OpenRSS Library for Obsidian

OpenRSS Library 是一个只读 Obsidian 插件，用于直接浏览自己的 OpenRSS 笔记、摘要翻译、全文翻译和段落对照。内容按需从 OpenRSS 读取，不会复制成 Vault 内的 Markdown、YAML、附件或数据库副本。

## 安装（推荐 BRAT）

要求 Obsidian 1.11.4 或更高版本。

1. 在 Obsidian 的第三方插件市场安装并启用 **BRAT**。
2. 在 BRAT 设置中选择 **Add Beta plugin**。
3. 输入 `https://github.com/lancescut/openrss-obsidian`。
4. 选择最新版本并完成安装。
5. 回到“设置 → 第三方插件”，启用 **OpenRSS Library**。

也可以从本仓库的 Releases 下载 `main.js`、`manifest.json` 和 `styles.css`，放入 Vault 的 `.obsidian/plugins/openrss-library/` 目录后重启 Obsidian。

## 连接 OpenRSS

1. 在 OpenRSS 中创建只读的 Obsidian 访问凭据。
2. 在插件设置中填写自己的 OpenRSS 地址。本机通常使用 `http://127.0.0.1:8787`；其他设备必须使用可信的 HTTPS 地址。
3. 在 Obsidian SecretStorage 中新建密钥并粘贴只读凭据。
4. 点击“测试连接”，成功后点击左侧 RSS 图标打开资料库。

凭据只保存在用户自己的 Obsidian SecretStorage 中。本仓库和 GitHub Releases 不包含用户地址、Token、密钥、密码、OpenRSS 内容或 `data.json`。

## 阅读功能

- 顶部资料类型、搜索、筛选和刷新控件保持在同一行。
- 笔记和翻译都可按订阅筛选；翻译按对应文章所属订阅匹配，多订阅文章不会重复显示。
- 手机端列表改为左侧抽屉：首次打开时展开，选择资料后自动收起；点击固定的“列表”按钮可随时展开或隐藏，让正文占满阅读区域。
- 桌面端继续使用左右分栏，可拖动列表分隔条，将左侧列表缩窄到接近隐藏。
- 桌面右键或移动端长按列表项，可标记或取消“当前阅读”。
- 保存阅读模式和标准化进度；再次打开时可选择返回上次位置。
- 使用“上一篇 / 下一篇”按钮翻页；桌面端支持 `K` / `J`。
- 可调整正文字号、行距和最大宽度。

## 数据与安全边界

- 笔记、翻译和附件的唯一持久化正文仍位于用户自己的 OpenRSS。
- 插件不调用 Vault 写入 API，不创建内容文件或附件副本。
- 正文详情只保留在当前 Obsidian 进程的有界内存缓存中，关闭视图或卸载插件时清理。
- 图片使用进程内 Blob URL，切换或关闭时撤销。
- 插件本地状态只包含连接地址、SecretStorage 密钥名称、布局、排版、资源 ID 标记和最多 500 条阅读位置元数据。
- 插件不使用 `localStorage`、IndexedDB、Node 文件系统或遥测。
- 当前版本只读，不会生成、重生成、编辑或删除 OpenRSS 数据。

OpenRSS 内容通过插件自定义 View 显示，不属于 Vault 文件，因此不会进入 File Explorer、Graph、Backlinks、Quick Switcher、Dataview/Bases 或 Obsidian 原生全文搜索。

## 开发与验证

```bash
npm install
npm run check
npm run build
npm run verify
```

构建产物为仓库根目录的 `main.js`。发布版本还包含 `manifest.json` 和 `styles.css`。
