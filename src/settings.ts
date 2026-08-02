import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian'

import type OpenRssLibraryPlugin from './main'
import { READING_APPEARANCE_LIMITS } from './plugin-state'


export class OpenRssSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OpenRssLibraryPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h2', { text: 'OpenRSS Library' })
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '插件只通过只读 API 显示内容，不会在 Vault 中创建笔记、YAML 或附件。',
    })

    new Setting(containerEl)
      .setName('OpenRSS 地址')
      .setDesc('本机可使用 http://127.0.0.1:8787；手机/远程设备请填写 Tailscale Serve 或其他可信 HTTPS 地址。')
      .addText((text) => text
        .setPlaceholder('http://127.0.0.1:8787')
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseUrl = value.trim()
          await this.plugin.saveConnectionSettings()
        }))

    new Setting(containerEl)
      .setName('只读 Token')
      .setDesc('选择现有密钥，或新建密钥并粘贴在 OpenRSS 设置页生成的 ors_ob_… Token。data.json 只保存密钥名称。')
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.secretName)
        .onChange(async (value) => {
          this.plugin.settings.secretName = value
          await this.plugin.saveConnectionSettings()
        }))

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('只有点击按钮时才会访问 OpenRSS。')
      .addButton((button) => button
        .setButtonText('测试')
        .onClick(async () => {
          button.setDisabled(true)
          try {
            const capabilities = await this.plugin.createClient().capabilities()
            new Notice(`连接成功：${capabilities.user.username}（只读）`)
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 8000)
          } finally {
            button.setDisabled(false)
          }
        }))

    containerEl.createEl('h3', { text: '阅读外观' })
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '以下设置只保存在插件本地，用于笔记、译文和段落对照，不会修改 OpenRSS 内容。',
    })
    const appearance = this.plugin.getReadingAppearance()

    const fontSizeSetting = new Setting(containerEl)
      .setName('正文字号')
      .setDesc(`${appearance.fontSize}px`)
    fontSizeSetting.addSlider((slider) => slider
        .setLimits(READING_APPEARANCE_LIMITS.fontSize.min, READING_APPEARANCE_LIMITS.fontSize.max, 1)
        .setDynamicTooltip()
        .setValue(appearance.fontSize)
        .onChange(async (value) => {
          fontSizeSetting.setDesc(`${value}px`)
          await this.plugin.setReadingAppearance({ ...this.plugin.getReadingAppearance(), fontSize: value })
        }))

    const lineHeightSetting = new Setting(containerEl)
      .setName('正文行距')
      .setDesc(String(appearance.lineHeight))
    lineHeightSetting.addSlider((slider) => slider
        .setLimits(READING_APPEARANCE_LIMITS.lineHeight.min, READING_APPEARANCE_LIMITS.lineHeight.max, 0.1)
        .setDynamicTooltip()
        .setValue(appearance.lineHeight)
        .onChange(async (value) => {
          lineHeightSetting.setDesc(value.toFixed(1))
          await this.plugin.setReadingAppearance({ ...this.plugin.getReadingAppearance(), lineHeight: value })
        }))

    const maxWidthSetting = new Setting(containerEl)
      .setName('正文最大宽度')
      .setDesc(`${appearance.maxWidth}px`)
    maxWidthSetting.addSlider((slider) => slider
        .setLimits(READING_APPEARANCE_LIMITS.maxWidth.min, READING_APPEARANCE_LIMITS.maxWidth.max, 40)
        .setDynamicTooltip()
        .setValue(appearance.maxWidth)
        .onChange(async (value) => {
          maxWidthSetting.setDesc(`${value}px`)
          await this.plugin.setReadingAppearance({ ...this.plugin.getReadingAppearance(), maxWidth: value })
        }))

    new Setting(containerEl)
      .setName('恢复默认阅读外观')
      .setDesc('字号 16px、行距 1.7、正文宽度 920px。')
      .addButton((button) => button
        .setButtonText('恢复默认')
        .onClick(async () => {
          await this.plugin.setReadingAppearance({ fontSize: 16, lineHeight: 1.7, maxWidth: 920 })
          this.display()
        }))

    containerEl.createEl('p', {
      cls: 'openrss-settings-boundary',
      text: '边界：这些资料不会出现在 Obsidian 文件列表、Graph、Backlinks、Dataview/Bases 或原生全文搜索中，也不支持离线阅读。',
    })
  }
}
