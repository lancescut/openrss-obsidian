import { Plugin } from 'obsidian'

import { OpenRssApiError, OpenRssClient, type ConnectionSettings } from './api/client'
import type { LibraryReadingPosition, LibraryResourceState } from './api/types'
import { OpenRssSettingTab } from './settings'
import {
  CURRENT_STATE_MIGRATION_VERSION,
  DEFAULT_PLUGIN_DATA,
  normalizeReadingAppearance,
  normalizeStoredPluginData,
  type FailedLegacyState,
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

export type ServerReadingPosition = {
  resourceId: number
  mode: ReadingViewMode
  contentRevision: string | null
  progress: number
  revision: number
  updatedAt: number
}


export default class OpenRssLibraryPlugin extends Plugin {
  settings: ConnectionSettings = { ...DEFAULT_SETTINGS }
  private legacyReadingMarkers = new Set<ReadingMarkerKey>()
  private legacyReadingPositions: ReadingPosition[] = []
  private stateMigrationVersion = 0
  private failedLegacyState: FailedLegacyState[] = []
  private listPaneWidth: number | null = null
  private serverReadingPositions = new Map<string, ServerReadingPosition>()
  private readingAppearance: ReadingAppearance = { ...DEFAULT_PLUGIN_DATA.readingAppearance }
  private saveQueue: Promise<void> = Promise.resolve()

  async onload(): Promise<void> {
    const stored = normalizeStoredPluginData(await this.loadData())
    this.settings = {
      baseUrl: stored.baseUrl,
      secretName: stored.secretName,
    }
    this.legacyReadingMarkers = new Set(stored.readingMarkers)
    this.legacyReadingPositions = stored.readingPositions
    this.stateMigrationVersion = stored.stateMigrationVersion
    this.failedLegacyState = stored.failedLegacyState
    this.listPaneWidth = stored.listPaneWidth
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

  hydrateResourceState(resourceId: number, state: LibraryResourceState | null): void {
    if (!state?.positions) return
    for (const position of state.positions) {
      if (!this.isReadingViewMode(position.view_mode)) continue
      const value: ServerReadingPosition = {
        resourceId,
        mode: position.view_mode,
        contentRevision: position.content_revision,
        progress: Math.min(1, Math.max(0, position.progress)),
        revision: position.revision,
        updatedAt: position.updated_at ? Date.parse(position.updated_at) : 0,
      }
      this.serverReadingPositions.set(this.serverPositionContext(resourceId, value.mode), value)
    }
  }

  getReadingPosition(resourceId: number, mode: ReadingViewMode): ServerReadingPosition | null {
    return this.serverReadingPositions.get(this.serverPositionContext(resourceId, mode)) || null
  }

  getLatestReadingPosition(resourceId: number): ServerReadingPosition | null {
    let latest: ServerReadingPosition | null = null
    for (const position of this.serverReadingPositions.values()) {
      if (position.resourceId !== resourceId) continue
      if (!latest || position.updatedAt > latest.updatedAt) latest = position
    }
    return latest
  }

  async setReadingPosition(position: Omit<ServerReadingPosition, 'revision' | 'updatedAt'>): Promise<void> {
    const context = this.serverPositionContext(position.resourceId, position.mode)
    const previous = this.serverReadingPositions.get(context)
    let saved: LibraryReadingPosition
    try {
      saved = await this.createClient().setPosition(position.resourceId, position.mode, {
        progress: Math.min(1, Math.max(0, position.progress)),
        content_revision: position.contentRevision,
        expected_revision: previous?.revision ?? 0,
      })
    } catch (error) {
      if (error instanceof OpenRssApiError && error.status === 409) {
        const current = error.detail?.current
        if (current && typeof current === 'object') {
          const value = current as Record<string, unknown>
          if (
            typeof value.progress === 'number'
            && typeof value.revision === 'number'
          ) {
            this.serverReadingPositions.set(context, {
              resourceId: position.resourceId,
              mode: position.mode,
              contentRevision: typeof value.content_revision === 'string'
                ? value.content_revision
                : null,
              progress: value.progress,
              revision: value.revision,
              updatedAt: typeof value.updated_at === 'string'
                ? Date.parse(value.updated_at)
                : Date.now(),
            })
          }
        }
        throw new Error('另一台设备已更新阅读位置；已保留服务器上的较新位置')
      }
      throw error
    }
    this.serverReadingPositions.set(context, {
      resourceId: position.resourceId,
      mode: position.mode,
      contentRevision: saved.content_revision,
      progress: saved.progress,
      revision: saved.revision,
      updatedAt: saved.updated_at ? Date.parse(saved.updated_at) : Date.now(),
    })
  }

  async migrateLegacyStateIfNeeded(): Promise<void> {
    if (this.stateMigrationVersion >= CURRENT_STATE_MIGRATION_VERSION) return
    const capabilities = await this.createClient().capabilities()
    if (!capabilities.features.library_state_write) return
    const failed: FailedLegacyState[] = []
    const markers = Array.from(this.legacyReadingMarkers).sort()
    for (let offset = 0; offset < markers.length; offset += 500) {
      const result = await this.createClient().importLocalState({
        markers: markers.slice(offset, offset + 500),
        positions: [],
      })
      failed.push(...this.failedImportRows(result.results))
    }
    for (let offset = 0; offset < this.legacyReadingPositions.length; offset += 500) {
      const result = await this.createClient().importLocalState({
        markers: [],
        positions: this.legacyReadingPositions.slice(offset, offset + 500),
      })
      failed.push(...this.failedImportRows(result.results))
    }
    this.legacyReadingMarkers.clear()
    this.legacyReadingPositions = []
    this.failedLegacyState = failed
    this.stateMigrationVersion = CURRENT_STATE_MIGRATION_VERSION
    await this.persistPluginData()
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
      readingMarkers: Array.from(this.legacyReadingMarkers).sort(),
      listPaneWidth: this.listPaneWidth,
      readingPositions: this.legacyReadingPositions,
      readingAppearance: { ...this.readingAppearance },
      stateMigrationVersion: this.stateMigrationVersion,
      failedLegacyState: this.failedLegacyState,
    }
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => this.saveData(snapshot))
    return this.saveQueue
  }

  private serverPositionContext(resourceId: number, mode: ReadingViewMode): string {
    return `${resourceId}|${mode}`
  }

  private isReadingViewMode(value: string): value is ReadingViewMode {
    return /^(?:note|summary|reader|segments|translation-text|translation-segments)$/.test(value)
  }

  private failedImportRows(
    rows: Array<{ type: 'marker' | 'position'; key: string; mode?: string; status: string; reason?: string }>,
  ): FailedLegacyState[] {
    return rows.filter((row) => row.status === 'failed').map((row) => ({
      type: row.type,
      key: row.key,
      mode: row.mode,
      reason: row.reason,
      retainedForVersion: CURRENT_STATE_MIGRATION_VERSION,
    }))
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
