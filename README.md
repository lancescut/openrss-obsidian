# OpenRSS Library for Obsidian

在 Obsidian 内直接浏览 OpenRSS 数据库中的笔记、摘要翻译、全文翻译和段落对照，不把这些内容复制成 Vault 文件。

## 安装

要求 Obsidian 1.11.4 或更高版本。

1. 将发布目录 `openrss-library` 整个复制到 Vault 的 `.obsidian/plugins/` 下。
2. 在 Obsidian → 设置 → 第三方插件中启用 **OpenRSS Library**。
3. 在 OpenRSS → 设置 → **Obsidian 访问**中创建一个 Token，并立即复制；建议同时启用“资料状态同步”。
4. 在 Obsidian → OpenRSS Library 设置中填写 OpenRSS 地址。
5. 在“Token”处创建/选择 SecretStorage 密钥并粘贴 Token。
6. 点击左侧 RSS 图标，或从命令面板执行“OpenRSS Library: 打开资料库”。

本机地址通常是 `http://127.0.0.1:8787`。如果 OpenRSS 在其他设备上，必须使用 HTTPS 地址。

### 通过 Tailscale 在手机/平板使用

OpenRSS 主机和移动设备必须登录同一个 tailnet。主机使用 Tailscale Serve 把只监听本机的 OpenRSS 端口发布成 tailnet 内部 HTTPS；不要使用会公开到互联网的 Funnel。

手机端填写该主机由 Tailscale Serve 提供的 `https://<设备名>.<tailnet>.ts.net[:端口]` 地址。Token 值不会随 Vault 配置同步；每台移动设备都要在 SecretStorage 中新建或选择密钥并粘贴 Token，然后执行“测试连接”。OpenRSS 主机和 Tailscale 必须保持在线。

如果使用 Obsidian Sync，在桌面和移动端分别开启“Active community plugin list”和“Installed community plugin list”，等待插件与设置下载后强制退出并重新打开 Obsidian。SecretStorage 仍需在手机端单独配置。

如果没有 Obsidian Sync，也可以手工把本插件发布目录复制到移动 Vault 的 `.obsidian/plugins/` 下。安装包不应包含 `data.json` 或 Token；请在手机 SecretStorage 中单独配置 Token。

## 阅读界面

- 顶部的资料类型、搜索、筛选和刷新控件压缩在同一行；窗口较窄时可横向滑动该行。
- 笔记和翻译都可按订阅筛选；翻译按对应文章所属订阅匹配，多订阅文章不会重复显示。
- Mermaid 图表由插件自带的 Mermaid 引擎渲染并清理 SVG，不再触发 Vault 的“允许”按钮。
- 手机端列表改为左侧抽屉：首次打开时展开，选择资料后自动收起；点击固定的“列表”按钮可随时展开或隐藏，让正文占满阅读区域。
- 桌面端可拖动列表与正文之间的分隔条，列表最窄可缩到 28px；宽度会保存在本插件的 `data.json` 中。
- 列表项右键/长按以及正文顶部按钮都可设置收藏、稍后读、阅读状态和标签；这些状态由 OpenRSS 服务端统一保存。
- 阅读状态不会因为打开资料、停留时间或滚动进度自动改变；新资料默认为“未读”，只有手动标记才会切换为“阅读中”或“已读”，也可随时重新标为“未读”。修改成功后以服务端返回状态统一覆盖列表、当前详情和内存缓存；跨设备变更同样以服务端为准。
- 左侧列表可按更新时间选择“最新在前”或“最早在前”，并通过“未读 / 阅读中 / 已读”复选框组合筛选；已读条目使用更淡的底色和标题样式。
- 笔记和译文正文支持鼠标拖选、移动端长按选择以及系统复制命令。
- “关联笔记/关联翻译”用于在独立资料之间跳转；笔记只显示笔记正文，全文翻译只显示“全文译文/段落对照”，不会把两组查看模式混在一起。
- 正文顶部显示阅读进度；离开一篇资料后会把模式和标准化位置同步到 OpenRSS，再次打开时可点击“返回上次位置”，不会强制跳转。
- 正文顶部和末尾都提供“上一篇/下一篇”按钮，读完后无需返回顶部即可继续；桌面键盘也可按 `K` / `J`，输入框聚焦时不会触发。
- 在插件设置的“阅读外观”中可调整正文字号、行距和最大宽度，笔记、译文与段落对照立即生效。

## 单一数据源保证

- 笔记、翻译和附件的唯一持久化正文仍位于 OpenRSS 数据库/资料目录。
- 插件不调用 Vault 写入 API，不创建 `.md`、YAML、JSON sidecar 或附件副本。
- 正文详情最多在内存中保留 10 篇或 20 MiB，View 关闭或插件卸载时清空。
- 图片只以进程内 Blob URL 显示，并在切换/关闭时撤销。
- `data.json` 只保存 OpenRSS 地址、SecretStorage 密钥名称、列表宽度、三项排版数值及一次性旧状态迁移元数据；收藏、稍后读、阅读状态、标签和阅读位置均以 OpenRSS 服务端为准。Token 值由 Obsidian SecretStorage 管理。
- 插件不会使用 `localStorage`、IndexedDB、Node 文件系统或遥测。

因此重启 Obsidian 且断网后不能继续阅读此前内容。这是“没有第二份持久化资料”的预期表现。

## 能力边界

这些资料由插件自定义 View 显示，并不是 Vault 文件，所以不会出现在 File Explorer、Graph、Backlinks、Quick Switcher、Dataview/Bases 或 Obsidian 原生全文搜索中。插件提供自己的服务端搜索、筛选和双语阅读界面。

当前版本不会生成、重生成或编辑 OpenRSS 正文；在 Token 授权后，只写入收藏、稍后读、阅读状态、标签和阅读位置。

## 开发和发布

运行 `npm run check && npm run build && npm run verify` 可完成类型检查、构建和安全策略检查。
