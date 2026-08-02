import { Plugin } from 'obsidian'

import { OpenRssClient, type ConnectionSettings } from './api/client'
import { OpenRssSettingTab } from './settings'
import {
  DEFAULT_PLUGIN_DATA,
  normalizeReadingAppearance,
  normalizeReadingPosition,
  normalizeStoredPluginData,
  type ReadingAppearance,
  type ReadingMarkerKey,
  type ReadingPosition,
  type ReadingViewMode,
  type StoredPluginData,
} from './plugin-state'
import { OPENRSS_LIBRARY_VIEW, OpenRssLibraryView } from './views/library-view'


const DEFAULT_SETTINGS: ConnectionSettings = {
  baseUrl: DEFAULT_PLUGIN_DATA.baseUrl,
  secretName: DEFAULT_PLUGIN_DATA.secretName,
}


export default class OpenRssLibraryPlugin extends Plugin {
  settings: ConnectionSettings = { ...DEFAULT_SETTINGS }
  private readingMarkers = new Set<ReadingMarkerKey>()
  private listPaneWidth: number | null = null
  private readingPositions = new Map<string, ReadingPosition>()
  private readingAppearance: ReadingAppearance = { ...DEFAULT_PLUGIN_DATA.readingAppearance }
  private saveQueue: Promise<void> = Promise.resolve()

  async onload(): Promise<void> {
    const stored = normalizeStoredPluginData(await this.loadData())
    this.settings = {
      baseUrl: stored.baseUrl,
      secretName: stored.secretName,
    }
    this.readingMarkers = new Set(stored.readingMarkers)
    this.listPaneWidth = stored.listPaneWidth
    this.readingPositions = new Map(stored.readingPositions.map((position) => [
      this.readingPositionContext(position.key, position.mode),
      position,
    ]))
    this.readingAppearance = stored.readingAppearance

    this.registerView(
      OPENRSS_LIBRARY_VIEW,
      (leaf) => new OpenRssLibraryView(leaf, this),
    )
    this.addRibbonIcon('rss', '打开 OpenRSS 资料库', () => void this.activateLibrary())
    this.addCommand({
      id: 'open-library',
      name: '打开资料库',
      callback: () => void this.activateLibrary(),
    })
    this.addSettingTab(new OpenRssSettingTab(this.app, this))
  }

  async onunload(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(OPENRSS_LIBRARY_VIEW)) {
      const view = leaf.view
      if (view instanceof OpenRssLibraryView) view.disposeMemory()
    }
  }

  createClient(): OpenRssClient {
    return new OpenRssClient(this.app, this.settings)
  }

  async saveConnectionSettings(): Promise<void> {
    await this.persistPluginData()
  }

  isReadingMarked(key: ReadingMarkerKey): boolean {
    return this.readingMarkers.has(key)
  }

  async setReadingMarked(key: ReadingMarkerKey, marked: boolean): Promise<void> {
    const previous = this.readingMarkers.has(key)
    if (marked) this.readingMarkers.add(key)
    else this.readingMarkers.delete(key)
    try {
      await this.persistPluginData()
    } catch (error) {
      if (previous) this.readingMarkers.add(key)
      else this.readingMarkers.delete(key)
      throw error
    }
  }

  getListPaneWidth(): number | null {
    return this.listPaneWidth
  }

  async setListPaneWidth(width: number): Promise<void> {
    const previous = this.listPaneWidth
    this.listPaneWidth = Math.round(width)
    try {
      await this.persistPluginData()
    } catch (error) {
      this.listPaneWidth = previous
      throw error
    }
  }

  getReadingPosition(key: ReadingMarkerKey, mode: ReadingViewMode): ReadingPosition | null {
    return this.readingPositions.get(this.readingPositionContext(key, mode)) || null
  }

  getLatestReadingPosition(key: ReadingMarkerKey): ReadingPosition | null {
    let latest: ReadingPosition | null = null
    for (const position of this.readingPositions.values()) {
      if (position.key !== key) continue
      if (!latest || position.updatedAt > latest.updatedAt) latest = position
    }
    return latest
  }

  async setReadingPosition(position: ReadingPosition): Promise<void> {
    const normalized = normalizeReadingPosition(position)
    if (!normalized) throw new Error('阅读位置无效')
    const context = this.readingPositionContext(normalized.key, normalized.mode)
    const previous = this.readingPositions.get(context)
    this.readingPositions.set(context, normalized)
    this.trimReadingPositions()
    try {
      await this.persistPluginData()
    } catch (error) {
      if (previous) this.readingPositions.set(context, previous)
      else this.readingPositions.delete(context)
      throw error
    }
  }

  getReadingAppearance(): ReadingAppearance {
    return { ...this.readingAppearance }
  }

  async setReadingAppearance(appearance: ReadingAppearance): Promise<void> {
    const previous = this.readingAppearance
    this.readingAppearance = normalizeReadingAppearance(appearance)
    this.applyReadingAppearanceToViews()
    try {
      await this.persistPluginData()
    } catch (error) {
      this.readingAppearance = previous
      this.applyReadingAppearanceToViews()
      throw error
    }
  }

  private persistPluginData(): Promise<void> {
    const snapshot: StoredPluginData = {
      baseUrl: this.settings.baseUrl,
      secretName: this.settings.secretName,
      readingMarkers: Array.from(this.readingMarkers).sort(),
      listPaneWidth: this.listPaneWidth,
      readingPositions: Array.from(this.readingPositions.values())
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 500),
      readingAppearance: { ...this.readingAppearance },
    }
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this.saveData(snapshot))
    return this.saveQueue
  }

  private readingPositionContext(key: ReadingMarkerKey, mode: ReadingViewMode): string {
    return `${key}|${mode}`
  }

  private trimReadingPositions(): void {
    if (this.readingPositions.size <= 500) return
    const retained = Array.from(this.readingPositions.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 500)
    this.readingPositions = new Map(retained.map((position) => [
      this.readingPositionContext(position.key, position.mode),
      position,
    ]))
  }

  private applyReadingAppearanceToViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(OPENRSS_LIBRARY_VIEW)) {
      const view = leaf.view
      if (view instanceof OpenRssLibraryView) view.applyReadingAppearance()
    }
  }

  private async activateLibrary(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(OPENRSS_LIBRARY_VIEW)[0]
    const leaf = existing || this.app.workspace.getLeaf('tab')
    if (!existing) {
      await leaf.setViewState({ type: OPENRSS_LIBRARY_VIEW, active: true })
    }
    await this.app.workspace.revealLeaf(leaf)
  }
}
