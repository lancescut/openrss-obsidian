import { Component, ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian'

import type OpenRssLibraryPlugin from '../main'
import type {
  NoteDetail,
  NoteFacets,
  NoteListItem,
  TranslationDetail,
  TranslationKind,
  TranslationListItem,
} from '../api/types'
import { jsonWeight, MemoryLru } from '../memory-cache'
import {
  LongPressGesture,
  LONG_PRESS_MOVE_TOLERANCE,
  LONG_PRESS_MS,
} from '../long-press'
import {
  noteMarkerKey,
  translationMarkerKey,
  type ReadingMarkerKey,
  type ReadingViewMode,
} from '../plugin-state'
import {
  normalizedReadingProgress,
  readingProgressPercent,
  scrollTopForProgress,
} from '../reading-progress'
import { NoteAssetSession } from '../render/assets'
import { renderMarkdown } from '../render/markdown'
import { nextMobileDrawerOpen, type MobileDrawerAction } from '../mobile-drawer'


export const OPENRSS_LIBRARY_VIEW = 'openrss-library-view'

const ROW_HEIGHT = 92
const OVERSCAN = 5
const DETAIL_CACHE_BYTES = 20 * 1024 * 1024
const MIN_LIST_PANE_WIDTH = 28
const MIN_DETAIL_PANE_WIDTH = 260
const SPLITTER_WIDTH = 10
type Resource = 'notes' | 'translations'
type NoteViewMode = 'note' | 'summary' | 'reader' | 'segments'
type TranslationViewMode = 'translation-text' | 'translation-segments'
type ListEntry =
  | { resource: 'notes'; value: NoteListItem }
  | { resource: 'translations'; value: TranslationListItem }
type CachedDetail =
  | { type: 'note'; data: NoteDetail; etag: string | null }
  | { type: 'translation'; data: TranslationDetail; etag: string | null }
type Selection =
  | { resource: 'notes'; id: number }
  | { resource: 'translations'; id: number; kind: TranslationKind }


export class OpenRssLibraryView extends ItemView {
  private resource: Resource = 'notes'
  private translationKind: TranslationKind = 'reader'
  private query = ''
  private status: string | null = 'done'
  private noteType: string | null = null
  private subscriptionId: number | null = null
  private targetLang = ''
  private entries: ListEntry[] = []
  private nextCursor: string | null = null
  private total = 0
  private facets: NoteFacets | null = null
  private loadingList = false
  private loadingMore = false
  private listGeneration = 0
  private detailGeneration = 0
  private contentGeneration = 0
  private selected: Selection | null = null
  private selectedNoteMode: NoteViewMode = 'note'
  private selectedTranslationMode: TranslationViewMode = 'translation-text'
  private searchTimer: number | null = null
  private progressSaveTimer: number | null = null
  private readingContentReady = false
  private readingProgressDirty = false
  private suppressProgressTracking = false
  private resumeDismissedContext: string | null = null
  private mobileListOpen = true
  private cache = new MemoryLru<CachedDetail>(10, DETAIL_CACHE_BYTES)
  private assets = new NoteAssetSession()
  private markdownScope: Component | null = null
  private splitterObserver: ResizeObserver | null = null
  private readonly longPress = new LongPressGesture(
    (callback, delayMs) => window.setTimeout(callback, delayMs),
    (timerId) => window.clearTimeout(timerId),
    LONG_PRESS_MS,
    LONG_PRESS_MOVE_TOLERANCE,
  )

  private toolbarEl!: HTMLElement
  private mobileListToggleEl!: HTMLButtonElement
  private filtersEl!: HTMLElement
  private bodyEl!: HTMLElement
  private listPaneEl!: HTMLElement
  private splitterEl!: HTMLElement
  private statsEl!: HTMLElement
  private scrollEl!: HTMLElement
  private virtualEl!: HTMLElement
  private detailEl!: HTMLElement
  private mobileListBackdropEl!: HTMLButtonElement
  private previousButtonEl: HTMLButtonElement | null = null
  private nextButtonEl: HTMLButtonElement | null = null
  private progressFillEl: HTMLElement | null = null
  private progressTextEl: HTMLElement | null = null
  private progressTrackEl: HTMLElement | null = null
  private resumeButtonEl: HTMLButtonElement | null = null

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OpenRssLibraryPlugin) {
    super(leaf)
  }

  getViewType(): string {
    return OPENRSS_LIBRARY_VIEW
  }

  getDisplayText(): string {
    return 'OpenRSS 资料库'
  }

  getIcon(): string {
    return 'rss'
  }

  async onOpen(): Promise<void> {
    this.renderShell()
    this.registerDomEvent(document, 'keydown', (event) => this.handleReadingShortcut(event))
    this.registerInterval(window.setInterval(() => {
      if (this.scrollEl.scrollTop < 100 && !document.hidden) void this.reload(false)
    }, 60_000))
    await this.reload(true)
  }

  async onClose(): Promise<void> {
    this.disposeMemory()
  }

  disposeMemory(): void {
    this.persistCurrentReadingProgress()
    this.listGeneration += 1
    this.detailGeneration += 1
    this.contentGeneration += 1
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    this.searchTimer = null
    if (this.progressSaveTimer !== null) window.clearTimeout(this.progressSaveTimer)
    this.progressSaveTimer = null
    this.readingContentReady = false
    this.clearLongPress()
    this.splitterObserver?.disconnect()
    this.splitterObserver = null
    this.assets.clear()
    this.cache.clear()
    this.clearMarkdownScope()
    this.entries = []
    this.selected = null
  }

  private renderShell(): void {
    this.persistCurrentReadingProgress()
    this.clearLongPress()
    this.splitterObserver?.disconnect()
    this.splitterObserver = null
    const root = this.contentEl
    root.empty()
    root.addClass('openrss-library')

    if (!this.selected) this.mobileListOpen = true

    this.toolbarEl = root.createDiv({ cls: 'openrss-library__topbar' })
    this.mobileListToggleEl = this.toolbarEl.createEl('button', {
      cls: 'openrss-library__mobile-list-toggle',
      text: '列表',
      attr: {
        type: 'button',
        'aria-label': '隐藏资料列表',
        'aria-expanded': 'true',
      },
    })
    this.mobileListToggleEl.addEventListener('click', () => this.setMobileListState('toggle'))
    const resourceTabs = this.toolbarEl.createDiv({ cls: 'openrss-library__tabs' })
    for (const [resource, label] of [['notes', '笔记'], ['translations', '翻译']] as const) {
      const button = resourceTabs.createEl('button', {
        cls: `openrss-library__tab${this.resource === resource ? ' is-active' : ''}`,
        text: label,
        attr: { type: 'button' },
      })
      button.addEventListener('click', () => {
        if (this.resource === resource) return
        this.persistCurrentReadingProgress()
        this.resource = resource
        this.selected = null
        this.mobileListOpen = true
        this.renderShell()
        void this.reload(true)
      })
    }

    const search = this.toolbarEl.createEl('input', {
      cls: 'openrss-library__search',
      attr: {
        type: 'search',
        placeholder: this.resource === 'notes' ? '搜索笔记…' : '搜索标题或译文…',
        'aria-label': '搜索 OpenRSS 资料',
      },
    })
    search.value = this.query
    search.addEventListener('input', () => {
      this.query = search.value.trim()
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => void this.reload(true), 320)
    })
    const refresh = this.toolbarEl.createEl('button', {
      cls: 'mod-cta',
      text: '刷新',
      attr: { type: 'button' },
    })
    refresh.addEventListener('click', () => void this.refreshAll())

    this.filtersEl = this.toolbarEl.createDiv({ cls: 'openrss-library__filters' })
    this.renderFilters()

    this.toolbarEl.appendChild(refresh)

    this.bodyEl = root.createDiv({ cls: 'openrss-library__body' })
    this.listPaneEl = this.bodyEl.createDiv({
      cls: 'openrss-library__list-pane',
      attr: { role: 'navigation', 'aria-label': 'OpenRSS 资料列表' },
    })
    this.statsEl = this.listPaneEl.createDiv({ cls: 'openrss-library__stats', text: '准备加载…' })
    this.scrollEl = this.listPaneEl.createDiv({ cls: 'openrss-library__scroll' })
    this.virtualEl = this.scrollEl.createDiv({ cls: 'openrss-library__virtual' })
    this.scrollEl.addEventListener('scroll', () => {
      this.renderVirtualRows()
      const remaining = this.virtualEl.offsetHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight
      if (remaining < 500) void this.loadMore()
    })
    this.splitterEl = this.bodyEl.createDiv({
      cls: 'openrss-library__splitter',
      attr: {
        role: 'separator',
        tabindex: '0',
        'aria-label': '调整资料列表宽度',
        'aria-orientation': 'vertical',
      },
    })
    this.splitterEl.createDiv({ cls: 'openrss-library__splitter-grip' })
    this.detailEl = this.bodyEl.createDiv({ cls: 'openrss-library__detail' })
    this.detailEl.addEventListener('scroll', () => this.handleDetailScroll())
    this.mobileListBackdropEl = this.bodyEl.createEl('button', {
      cls: 'openrss-library__mobile-list-backdrop',
      attr: { type: 'button', 'aria-label': '关闭资料列表', tabindex: '-1' },
    })
    this.mobileListBackdropEl.addEventListener('click', () => this.setMobileListState('close'))
    this.applyMobileListState()
    this.configureListSplitter()
    this.applyReadingAppearance()
    this.renderEmptyDetail()
  }

  applyReadingAppearance(): void {
    const appearance = this.plugin.getReadingAppearance()
    this.contentEl.style.setProperty('--openrss-reading-font-size', `${appearance.fontSize}px`)
    this.contentEl.style.setProperty('--openrss-reading-line-height', String(appearance.lineHeight))
    this.contentEl.style.setProperty('--openrss-reading-max-width', `${appearance.maxWidth}px`)
  }

  private renderFilters(): void {
    this.filtersEl.empty()
    if (this.resource === 'notes') {
      this.addSelect(this.filtersEl, '状态', this.status || '', [
        ['', '全部状态'],
        ['done', '已完成'],
        ['queued', '生成中'],
        ['failed', '失败'],
      ], (value) => {
        this.status = value || null
        void this.reload(true)
      })
      this.addSelect(this.filtersEl, '类型', this.noteType || '', [
        ['', '全部类型'],
        ['paper_note', '论文笔记'],
        ['tech_note', '技术笔记'],
      ], (value) => {
        this.noteType = value || null
        void this.reload(true)
      })
      const subscriptions: Array<[string, string]> = [['', '全部订阅']]
      for (const row of this.facets?.subscriptions || []) {
        subscriptions.push([String(row.id), `${row.name || `#${row.id}`} (${row.count})`])
      }
      this.addSelect(this.filtersEl, '订阅', this.subscriptionId ? String(this.subscriptionId) : '', subscriptions, (value) => {
        this.subscriptionId = value ? Number(value) : null
        void this.reload(true)
      })
    } else {
      this.addSelect(this.filtersEl, '翻译类型', this.translationKind, [
        ['reader', '全文翻译'],
        ['summary', '摘要翻译'],
      ], (value) => {
        this.translationKind = value as TranslationKind
        this.selected = null
        void this.reload(true)
      })
      const language = this.filtersEl.createEl('input', {
        cls: 'openrss-library__filter-input',
        attr: { type: 'text', placeholder: '目标语言，如 zh', 'aria-label': '目标语言' },
      })
      language.value = this.targetLang
      language.addEventListener('change', () => {
        this.targetLang = language.value.trim()
        void this.reload(true)
      })
    }
  }

  private addSelect(
    parent: HTMLElement,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => void,
  ): void {
    const select = parent.createEl('select', { attr: { 'aria-label': label } })
    for (const [optionValue, optionLabel] of options) {
      const option = select.createEl('option', { text: optionLabel, value: optionValue })
      option.selected = optionValue === value
    }
    select.addEventListener('change', () => onChange(select.value))
  }

  private configureListSplitter(): void {
    const applyInitialWidth = () => {
      if (!this.bodyEl.isConnected || this.bodyEl.clientWidth <= 0) return
      const storedWidth = this.plugin.getListPaneWidth()
      const preferredWidth = storedWidth ?? Math.round(this.bodyEl.clientWidth * 0.34)
      this.applyListPaneWidth(preferredWidth)
    }
    window.requestAnimationFrame(applyInitialWidth)

    let startX = 0
    let startWidth = 0
    let activePointerId: number | null = null
    const finishResize = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return
      activePointerId = null
      this.bodyEl.removeClass('is-resizing')
      if (this.splitterEl.hasPointerCapture(event.pointerId)) {
        this.splitterEl.releasePointerCapture(event.pointerId)
      }
      const width = this.currentListPaneWidth()
      void this.plugin.setListPaneWidth(width).catch((error) => {
        new Notice(`无法保存列表宽度：${this.errorText(error)}`, 7000)
      })
    }
    this.splitterEl.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return
      event.preventDefault()
      activePointerId = event.pointerId
      startX = event.clientX
      startWidth = this.currentListPaneWidth()
      this.bodyEl.addClass('is-resizing')
      this.splitterEl.setPointerCapture(event.pointerId)
    })
    this.splitterEl.addEventListener('pointermove', (event) => {
      if (activePointerId !== event.pointerId) return
      this.applyListPaneWidth(startWidth + event.clientX - startX)
    })
    this.splitterEl.addEventListener('pointerup', finishResize)
    this.splitterEl.addEventListener('pointercancel', finishResize)
    this.splitterEl.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
      event.preventDefault()
      const width = event.key === 'Home'
        ? MIN_LIST_PANE_WIDTH
        : this.currentListPaneWidth() + (event.key === 'ArrowLeft' ? -24 : 24)
      this.applyListPaneWidth(width)
      void this.plugin.setListPaneWidth(this.currentListPaneWidth())
    })

    this.splitterObserver = new ResizeObserver(() => {
      if (this.bodyEl.clientWidth <= 0) return
      this.applyListPaneWidth(this.currentListPaneWidth())
    })
    this.splitterObserver.observe(this.bodyEl)
  }

  private applyListPaneWidth(rawWidth: number): void {
    const maxWidth = Math.max(
      MIN_LIST_PANE_WIDTH,
      this.bodyEl.clientWidth - MIN_DETAIL_PANE_WIDTH - SPLITTER_WIDTH,
    )
    const width = Math.min(maxWidth, Math.max(MIN_LIST_PANE_WIDTH, Math.round(rawWidth)))
    this.bodyEl.style.setProperty('--openrss-list-width', `${width}px`)
    this.splitterEl.setAttribute('aria-valuemin', String(MIN_LIST_PANE_WIDTH))
    this.splitterEl.setAttribute('aria-valuemax', String(maxWidth))
    this.splitterEl.setAttribute('aria-valuenow', String(width))
  }

  private currentListPaneWidth(): number {
    const value = Number.parseFloat(this.bodyEl.style.getPropertyValue('--openrss-list-width'))
    return Number.isFinite(value) ? value : Math.max(MIN_LIST_PANE_WIDTH, this.listPaneEl.clientWidth)
  }

  private async reload(showLoading: boolean): Promise<void> {
    const generation = ++this.listGeneration
    this.nextCursor = null
    this.loadingList = true
    if (showLoading) {
      this.entries = []
      this.statsEl.setText('加载中…')
      this.renderVirtualRows()
    }
    try {
      const page = this.resource === 'notes'
        ? await this.plugin.createClient().notes({
          limit: 50,
          q: this.query,
          status: this.status,
          noteType: this.noteType,
          subscriptionId: this.subscriptionId,
        })
        : await this.plugin.createClient().translations({
          kind: this.translationKind,
          limit: 50,
          q: this.query,
          targetLang: this.targetLang,
        })
      if (generation !== this.listGeneration) return
      if (this.resource === 'notes' && 'facets' in page) {
        this.facets = page.facets
      }
      this.entries = page.items.map((value) => this.resource === 'notes'
        ? { resource: 'notes' as const, value: value as NoteListItem }
        : { resource: 'translations' as const, value: value as TranslationListItem })
      this.nextCursor = page.next_cursor
      this.total = page.total
      this.statsEl.setText(`${this.total.toLocaleString()} 条 · 当前加载 ${this.entries.length.toLocaleString()} 条`)
      this.renderFilters()
      this.renderVirtualRows()
      this.updateNavigationButtons()
    } catch (error) {
      if (generation !== this.listGeneration) return
      this.entries = []
      this.statsEl.setText(this.errorText(error))
      this.renderVirtualRows()
      this.updateNavigationButtons()
    } finally {
      if (generation === this.listGeneration) this.loadingList = false
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loadingList || this.loadingMore || !this.nextCursor) return
    const generation = this.listGeneration
    const cursor = this.nextCursor
    this.loadingMore = true
    try {
      const page = this.resource === 'notes'
        ? await this.plugin.createClient().notes({
          cursor,
          limit: 50,
          q: this.query,
          status: this.status,
          noteType: this.noteType,
          subscriptionId: this.subscriptionId,
        })
        : await this.plugin.createClient().translations({
          kind: this.translationKind,
          cursor,
          limit: 50,
          q: this.query,
          targetLang: this.targetLang,
        })
      if (generation !== this.listGeneration) return
      const additions: ListEntry[] = page.items.map((value) => this.resource === 'notes'
        ? { resource: 'notes', value: value as NoteListItem }
        : { resource: 'translations', value: value as TranslationListItem })
      this.entries.push(...additions)
      this.nextCursor = page.next_cursor
      this.statsEl.setText(`${this.total.toLocaleString()} 条 · 当前加载 ${this.entries.length.toLocaleString()} 条`)
      this.renderVirtualRows()
    } catch (error) {
      new Notice(this.errorText(error), 7000)
    } finally {
      this.loadingMore = false
    }
  }

  private renderVirtualRows(): void {
    if (!this.virtualEl) return
    this.clearLongPress()
    this.virtualEl.empty()
    this.virtualEl.style.height = `${Math.max(this.entries.length * ROW_HEIGHT, this.scrollEl.clientHeight)}px`
    if (!this.entries.length) {
      const empty = this.virtualEl.createDiv({
        cls: 'openrss-library__empty-list',
        text: this.loadingList ? '加载中…' : '没有符合条件的资料',
      })
      empty.style.top = '20px'
      return
    }
    const first = Math.max(0, Math.floor(this.scrollEl.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const visibleCount = Math.ceil(this.scrollEl.clientHeight / ROW_HEIGHT) + OVERSCAN * 2
    const last = Math.min(this.entries.length, first + visibleCount)
    for (let index = first; index < last; index += 1) {
      const entry = this.entries[index]
      const markerKey = this.entryMarkerKey(entry)
      const marked = this.plugin.isReadingMarked(markerKey)
      const row = this.virtualEl.createEl('button', {
        cls: [
          'openrss-library__row',
          this.isSelected(entry) ? 'is-selected' : '',
          marked ? 'is-reading-marked' : '',
        ].filter(Boolean).join(' '),
        attr: {
          type: 'button',
          'aria-label': `${entry.resource === 'notes' ? entry.value.title : entry.value.item.title}${marked ? '，当前阅读' : ''}`,
        },
      })
      row.style.top = `${index * ROW_HEIGHT}px`
      const title = entry.resource === 'notes' ? entry.value.title : entry.value.item.title
      const titleRow = row.createDiv({ cls: 'openrss-library__row-title-line' })
      titleRow.createDiv({ cls: 'openrss-library__row-title', text: title })
      if (marked) titleRow.createSpan({ cls: 'openrss-library__reading-badge', text: '在读' })
      const meta = entry.resource === 'notes'
        ? `${entry.value.subscription.name || '未命名订阅'} · ${this.noteTypeLabel(entry.value.note_type)} · ${this.formatDate(entry.value.updated_at)}`
        : `${entry.value.kind === 'reader' ? '全文' : '摘要'} · ${entry.value.target_lang} · ${entry.value.char_count.toLocaleString()} 字符 · ${this.formatDate(entry.value.updated_at)}`
      row.createDiv({ cls: 'openrss-library__row-meta', text: meta })
      const snippet = entry.resource === 'notes' ? entry.value.snippet : `${entry.value.provider} / ${entry.value.model}`
      if (snippet) row.createDiv({ cls: 'openrss-library__row-snippet', text: snippet })
      this.bindEntryInteractions(row, entry)
    }
  }

  private bindEntryInteractions(row: HTMLButtonElement, entry: ListEntry): void {
    let suppressClick = false
    let suppressContextUntil = 0
    row.addEventListener('click', (event) => {
      if (suppressClick) {
        event.preventDefault()
        event.stopPropagation()
        suppressClick = false
        return
      }
      void this.openEntry(entry)
    })
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (Date.now() < suppressContextUntil) return
      this.showReadingMarkerMenu(entry, event.clientX, event.clientY)
    })
    row.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.pointerType === 'mouse') return
      const startX = event.clientX
      const startY = event.clientY
      const pointerId = event.pointerId
      this.longPress.start(pointerId, startX, startY, () => {
        suppressClick = true
        suppressContextUntil = Date.now() + 1000
        this.showReadingMarkerMenu(entry, startX, startY)
      })
      row.setPointerCapture(pointerId)
    })
    row.addEventListener('pointermove', (event) => {
      this.longPress.move(event.pointerId, event.clientX, event.clientY)
    })
    const finishPointer = (event: PointerEvent) => {
      this.longPress.end(event.pointerId)
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId)
    }
    row.addEventListener('pointerup', finishPointer)
    row.addEventListener('pointercancel', finishPointer)
    row.addEventListener('lostpointercapture', (event) => {
      this.longPress.end(event.pointerId)
    })
  }

  private showReadingMarkerMenu(entry: ListEntry, x: number, y: number): void {
    const key = this.entryMarkerKey(entry)
    const marked = this.plugin.isReadingMarked(key)
    const menu = new Menu()
    menu.addItem((item) => item
      .setTitle(marked ? '取消当前阅读标记' : '标记为当前阅读')
      .setIcon(marked ? 'bookmark-x' : 'bookmark')
      .onClick(() => void this.updateReadingMarker(key, !marked)))
    menu.showAtPosition({ x, y })
  }

  private async updateReadingMarker(key: ReadingMarkerKey, marked: boolean): Promise<void> {
    try {
      await this.plugin.setReadingMarked(key, marked)
      this.renderVirtualRows()
      new Notice(marked ? '已标记为当前阅读' : '已取消当前阅读标记')
    } catch (error) {
      new Notice(`无法保存阅读标记：${this.errorText(error)}`, 7000)
    }
  }

  private entryMarkerKey(entry: ListEntry): ReadingMarkerKey {
    return entry.resource === 'notes'
      ? noteMarkerKey(entry.value.id)
      : translationMarkerKey(entry.value.kind, entry.value.id)
  }

  private clearLongPress(): void {
    this.longPress.cancel()
  }

  private isSelected(entry: ListEntry): boolean {
    if (!this.selected || this.selected.resource !== entry.resource) return false
    return this.selected.id === entry.value.id
  }

  private async openEntry(entry: ListEntry): Promise<void> {
    if (entry.resource === 'notes') {
      await this.openNote(entry.value.id)
    } else {
      await this.openTranslation(entry.value.kind, entry.value.id)
    }
  }

  private async openNote(noteId: number, preferredMode?: NoteViewMode): Promise<void> {
    this.persistCurrentReadingProgress()
    const generation = ++this.detailGeneration
    this.selected = { resource: 'notes', id: noteId }
    this.setMobileListState('select')
    const latestMode = this.plugin.getLatestReadingPosition(noteMarkerKey(noteId))?.mode
    this.selectedNoteMode = preferredMode || (this.isNoteViewMode(latestMode) ? latestMode : 'note')
    this.selectedTranslationMode = 'translation-text'
    this.resumeDismissedContext = null
    this.assets.clear()
    this.renderVirtualRows()
    this.renderLoadingDetail()
    const key = `note:${noteId}`
    const cached = this.cache.get(key)
    try {
      const result = await this.plugin.createClient().note(
        noteId,
        cached?.type === 'note' ? cached.etag : null,
      )
      if (generation !== this.detailGeneration) return
      let detail: NoteDetail
      let etag: string | null
      if (result.notModified && cached?.type === 'note') {
        detail = cached.data
        etag = result.etag || cached.etag
      } else if (!result.notModified) {
        detail = result.data
        etag = result.etag
        this.cache.set(key, { type: 'note', data: detail, etag }, jsonWeight(detail))
      } else {
        throw new Error('OpenRSS 返回了无正文的缓存响应')
      }
      await this.renderNoteDetail(detail, generation)
    } catch (error) {
      if (generation === this.detailGeneration) this.renderDetailError(error)
    }
  }

  private async openTranslation(
    kind: TranslationKind,
    translationId: number,
    preferredMode?: TranslationViewMode,
  ): Promise<void> {
    this.persistCurrentReadingProgress()
    const generation = ++this.detailGeneration
    this.selected = { resource: 'translations', id: translationId, kind }
    this.setMobileListState('select')
    const latestMode = this.plugin.getLatestReadingPosition(translationMarkerKey(kind, translationId))?.mode
    this.selectedTranslationMode = preferredMode
      || (this.isTranslationViewMode(latestMode) ? latestMode : 'translation-text')
    this.resumeDismissedContext = null
    this.assets.clear()
    this.renderVirtualRows()
    this.renderLoadingDetail()
    const key = `translation:${kind}:${translationId}`
    const cached = this.cache.get(key)
    try {
      const result = await this.plugin.createClient().translation(
        kind,
        translationId,
        cached?.type === 'translation' ? cached.etag : null,
      )
      if (generation !== this.detailGeneration) return
      let detail: TranslationDetail
      let etag: string | null
      if (result.notModified && cached?.type === 'translation') {
        detail = cached.data
        etag = result.etag || cached.etag
      } else if (!result.notModified) {
        detail = result.data
        etag = result.etag
        this.cache.set(key, { type: 'translation', data: detail, etag }, jsonWeight(detail))
      } else {
        throw new Error('OpenRSS 返回了无译文的缓存响应')
      }
      await this.renderTranslationDetail(detail, generation)
    } catch (error) {
      if (generation === this.detailGeneration) this.renderDetailError(error)
    }
  }

  private async renderNoteDetail(detail: NoteDetail, generation: number): Promise<void> {
    if (generation !== this.detailGeneration) return
    this.detailEl.empty()
    this.renderReadingControls()
    const heading = this.detailEl.createDiv({ cls: 'openrss-library__detail-heading' })
    const headingText = heading.createDiv()
    headingText.createEl('h2', { text: detail.note.title })
    headingText.createDiv({
      cls: 'openrss-library__detail-meta',
      text: `${detail.subscription.name || '未命名订阅'} · ${this.noteTypeLabel(detail.note.note_type)} · ${this.formatDate(detail.note.updated_at)}`,
    })
    const links = heading.createDiv({ cls: 'openrss-library__detail-links' })
    this.addExternalLink(links, detail.links.source, '原文')
    this.addExternalLink(
      links,
      this.plugin.createClient().openRssWebUrl(`/notes/${detail.note.id}`),
      '在 OpenRSS 打开',
    )

    const tabs = this.detailEl.createDiv({ cls: 'openrss-library__detail-tabs' })
    const choices: Array<[NoteViewMode, string, number | null]> = [
      ['note', '笔记', null],
      ['summary', '摘要翻译', detail.translations.summary.length],
      ['reader', '全文翻译', detail.translations.reader.length],
      ['segments', '段落对照', detail.translations.reader.filter((row) => row.translated_segments?.length).length],
    ]
    const content = this.detailEl.createDiv({ cls: 'openrss-library__markdown markdown-rendered' })
    const switchMode = async (mode: NoteViewMode) => {
      if (mode === this.selectedNoteMode && this.readingContentReady) return
      this.persistCurrentReadingProgress()
      this.readingContentReady = false
      this.selectedNoteMode = mode
      this.resumeDismissedContext = null
      this.detailEl.scrollTop = 0
      for (const button of Array.from(tabs.querySelectorAll('button'))) {
        button.toggleClass('is-active', button.dataset.mode === mode)
      }
      await this.renderNoteMode(content, detail, mode, generation)
      this.finishReadingContent(generation)
      this.readingProgressDirty = true
      this.scheduleReadingProgressSave()
    }
    for (const [mode, label, count] of choices) {
      const button = tabs.createEl('button', {
        cls: `openrss-library__tab${this.selectedNoteMode === mode ? ' is-active' : ''}`,
        text: count === null ? label : `${label} (${count})`,
        attr: { type: 'button', 'data-mode': mode },
      })
      button.addEventListener('click', () => void switchMode(mode))
    }
    await this.renderNoteMode(content, detail, this.selectedNoteMode, generation)
    this.finishReadingContent(generation)
  }

  private async renderNoteMode(
    container: HTMLElement,
    detail: NoteDetail,
    mode: NoteViewMode,
    generation: number,
  ): Promise<void> {
    const contentGeneration = ++this.contentGeneration
    const markdownOwner = this.resetMarkdownScope()
    container.empty()
    this.assets.clear()
    if (mode === 'note') {
      const original = detail.note.body_md || detail.note.summary || '这篇笔记没有正文。'
      let markdown = original
      try {
        markdown = await this.assets.hydrate(
          this.plugin.createClient(), detail.note.id, original, detail.assets,
        )
      } catch {
        this.assets.clear()
        container.createDiv({ cls: 'openrss-library__warning', text: '部分图片加载失败，正文仍可阅读。' })
      }
      if (generation !== this.detailGeneration || contentGeneration !== this.contentGeneration) {
        this.assets.clear()
        return
      }
      await renderMarkdown(this.app, markdownOwner, container, markdown)
      return
    }
    if (mode === 'summary') {
      if (!detail.translations.summary.length) {
        container.createDiv({ cls: 'openrss-library__empty-detail', text: '没有已有的摘要翻译。' })
        return
      }
      for (const translation of detail.translations.summary) {
        container.createEl('h3', { text: `${translation.target_lang} · ${translation.model}` })
        const section = container.createDiv({ cls: 'openrss-library__translation-section' })
        if (contentGeneration !== this.contentGeneration) return
        await renderMarkdown(this.app, markdownOwner, section, translation.translated_text)
      }
      return
    }
    if (mode === 'reader') {
      if (!detail.translations.reader.length) {
        container.createDiv({ cls: 'openrss-library__empty-detail', text: '没有已有的全文翻译。' })
        return
      }
      for (const translation of detail.translations.reader) {
        container.createEl('h3', { text: `${translation.target_lang} · ${translation.source_mode} · ${translation.model}` })
        const section = container.createDiv({ cls: 'openrss-library__translation-section' })
        if (contentGeneration !== this.contentGeneration) return
        await renderMarkdown(this.app, markdownOwner, section, translation.translated_text)
      }
      return
    }
    const translated = detail.translations.reader.filter((row) => row.translated_segments?.length)
    if (!translated.length) {
      container.createDiv({ cls: 'openrss-library__empty-detail', text: '这篇全文翻译没有段落对照数据。' })
      return
    }
    for (const translation of translated) {
      container.createEl('h3', { text: `${translation.target_lang} · ${translation.source_mode}` })
      this.renderSegments(container, translation.translated_segments || [])
    }
  }

  private async renderTranslationDetail(detail: TranslationDetail, generation: number): Promise<void> {
    if (generation !== this.detailGeneration) return
    this.detailEl.empty()
    this.renderReadingControls()
    const heading = this.detailEl.createDiv({ cls: 'openrss-library__detail-heading' })
    const headingText = heading.createDiv()
    headingText.createEl('h2', { text: detail.item.title })
    headingText.createDiv({
      cls: 'openrss-library__detail-meta',
      text: `${detail.kind === 'reader' ? '全文翻译' : '摘要翻译'} · ${detail.source_language} → ${detail.target_lang} · ${detail.source_mode} · ${this.formatDate(detail.updated_at)}`,
    })
    const links = heading.createDiv({ cls: 'openrss-library__detail-links' })
    this.addExternalLink(links, detail.item.url, '原文')

    if (detail.note_ids.length) {
      const notes = this.detailEl.createDiv({ cls: 'openrss-library__related-notes' })
      notes.createSpan({ text: '关联笔记：' })
      for (const noteId of detail.note_ids) {
        const button = notes.createEl('button', { text: `#${noteId}`, attr: { type: 'button' } })
        button.addEventListener('click', () => void this.openNote(noteId))
      }
    }
    if (detail.translated_segments?.length) {
      const tabs = this.detailEl.createDiv({ cls: 'openrss-library__detail-tabs' })
      const textButton = tabs.createEl('button', { cls: 'openrss-library__tab', text: '译文', attr: { type: 'button' } })
      const segmentButton = tabs.createEl('button', { cls: 'openrss-library__tab', text: '段落对照', attr: { type: 'button' } })
      const content = this.detailEl.createDiv({ cls: 'openrss-library__markdown markdown-rendered' })
      const showText = async (userInitiated: boolean) => {
        if (userInitiated && this.selectedTranslationMode === 'translation-text' && this.readingContentReady) return
        this.persistCurrentReadingProgress()
        this.readingContentReady = false
        this.selectedTranslationMode = 'translation-text'
        this.resumeDismissedContext = null
        this.detailEl.scrollTop = 0
        const tabGeneration = ++this.contentGeneration
        const tabOwner = this.resetMarkdownScope()
        textButton.addClass('is-active'); segmentButton.removeClass('is-active')
        content.empty()
        await renderMarkdown(this.app, tabOwner, content, detail.translated_text)
        if (tabGeneration !== this.contentGeneration) return
        this.finishReadingContent(generation)
        if (userInitiated) {
          this.readingProgressDirty = true
          this.scheduleReadingProgressSave()
        }
      }
      const showSegments = (userInitiated: boolean) => {
        if (userInitiated && this.selectedTranslationMode === 'translation-segments' && this.readingContentReady) return
        this.persistCurrentReadingProgress()
        this.readingContentReady = false
        this.selectedTranslationMode = 'translation-segments'
        this.resumeDismissedContext = null
        this.detailEl.scrollTop = 0
        this.contentGeneration += 1
        this.clearMarkdownScope()
        textButton.removeClass('is-active'); segmentButton.addClass('is-active')
        content.empty(); this.renderSegments(content, detail.translated_segments || [])
        this.finishReadingContent(generation)
        if (userInitiated) {
          this.readingProgressDirty = true
          this.scheduleReadingProgressSave()
        }
      }
      textButton.addEventListener('click', () => void showText(true))
      segmentButton.addEventListener('click', () => showSegments(true))
      if (this.selectedTranslationMode === 'translation-segments') showSegments(false)
      else await showText(false)
    } else {
      this.selectedTranslationMode = 'translation-text'
      const contentGeneration = ++this.contentGeneration
      const markdownOwner = this.resetMarkdownScope()
      const content = this.detailEl.createDiv({ cls: 'openrss-library__markdown markdown-rendered' })
      if (contentGeneration !== this.contentGeneration) return
      await renderMarkdown(this.app, markdownOwner, content, detail.translated_text)
      this.finishReadingContent(generation)
    }
  }

  private renderSegments(container: HTMLElement, segments: Array<{ src: string; trans: string }>): void {
    const grid = container.createDiv({ cls: 'openrss-library__segments' })
    for (const [index, segment] of segments.entries()) {
      const row = grid.createDiv({ cls: 'openrss-library__segment' })
      row.createDiv({ cls: 'openrss-library__segment-number', text: String(index + 1) })
      row.createDiv({ cls: 'openrss-library__segment-source', text: segment.src })
      row.createDiv({ cls: 'openrss-library__segment-translation', text: segment.trans })
    }
  }

  private renderReadingControls(): void {
    const controls = this.detailEl.createDiv({ cls: 'openrss-library__reading-controls' })
    const navigation = controls.createDiv({ cls: 'openrss-library__reading-navigation' })
    this.previousButtonEl = navigation.createEl('button', {
      text: '上一篇',
      attr: { type: 'button', 'aria-label': '上一篇（K）', title: '上一篇（K）' },
    })
    this.previousButtonEl.addEventListener('click', () => void this.moveSelection(-1))
    this.nextButtonEl = navigation.createEl('button', {
      text: '下一篇',
      attr: { type: 'button', 'aria-label': '下一篇（J）', title: '下一篇（J）' },
    })
    this.nextButtonEl.addEventListener('click', () => void this.moveSelection(1))

    const progress = controls.createDiv({ cls: 'openrss-library__reading-progress' })
    this.progressTrackEl = progress.createDiv({
      cls: 'openrss-library__progress-track',
      attr: {
        role: 'progressbar',
        'aria-label': '当前阅读进度',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
      },
    })
    this.progressFillEl = this.progressTrackEl.createDiv({ cls: 'openrss-library__progress-fill' })
    this.progressTextEl = progress.createDiv({ cls: 'openrss-library__progress-text', text: '0%' })
    this.resumeButtonEl = controls.createEl('button', {
      cls: 'openrss-library__resume-button is-hidden',
      text: '返回上次位置',
      attr: { type: 'button' },
    })
    this.resumeButtonEl.addEventListener('click', () => this.restoreReadingPosition())
    this.updateNavigationButtons()
    this.updateReadingProgressUi()
    this.updateResumeButton()
  }

  private async moveSelection(delta: -1 | 1): Promise<void> {
    let index = this.selectedEntryIndex()
    if (index < 0) return
    if (delta === 1 && index + 1 >= this.entries.length && this.nextCursor) {
      await this.loadMore()
      index = this.selectedEntryIndex()
    }
    const entry = this.entries[index + delta]
    if (!entry) return
    await this.openEntry(entry)
  }

  private selectedEntryIndex(): number {
    if (!this.selected) return -1
    return this.entries.findIndex((entry) => this.isSelected(entry))
  }

  private updateNavigationButtons(): void {
    if (!this.previousButtonEl || !this.nextButtonEl) return
    const index = this.selectedEntryIndex()
    this.previousButtonEl.disabled = index <= 0
    this.nextButtonEl.disabled = index < 0 || (index >= this.entries.length - 1 && !this.nextCursor)
  }

  private handleReadingShortcut(event: KeyboardEvent): void {
    if (this.app.workspace.activeLeaf !== this.leaf) return
    if (
      event.key === 'Escape'
      && this.mobileListOpen
      && window.matchMedia('(max-width: 760px)').matches
    ) {
      event.preventDefault()
      this.setMobileListState('close')
      return
    }
    if (!this.selected) return
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)
    ) return
    const key = event.key.toLowerCase()
    if (key !== 'j' && key !== 'k') return
    event.preventDefault()
    void this.moveSelection(key === 'j' ? 1 : -1)
  }

  private setMobileListState(action: MobileDrawerAction): void {
    this.mobileListOpen = nextMobileDrawerOpen(this.mobileListOpen, action)
    this.applyMobileListState()
  }

  private applyMobileListState(): void {
    if (!this.bodyEl || !this.mobileListToggleEl) return
    this.bodyEl.toggleClass('is-mobile-list-open', this.mobileListOpen)
    this.mobileListToggleEl.setAttribute('aria-expanded', String(this.mobileListOpen))
    this.mobileListToggleEl.setAttribute(
      'aria-label',
      this.mobileListOpen ? '隐藏资料列表' : '展开资料列表',
    )
    if (this.mobileListBackdropEl) {
      this.mobileListBackdropEl.setAttribute('aria-hidden', String(!this.mobileListOpen))
    }
  }

  private handleDetailScroll(): void {
    if (!this.readingContentReady) return
    this.updateReadingProgressUi()
    if (this.suppressProgressTracking) return
    const context = this.currentReadingContext()
    if (!context) return
    this.resumeDismissedContext = this.readingContextId(context.key, context.mode)
    this.readingProgressDirty = true
    this.updateResumeButton()
    this.scheduleReadingProgressSave()
  }

  private finishReadingContent(generation: number): void {
    if (generation !== this.detailGeneration) return
    this.suppressProgressTracking = true
    this.readingContentReady = false
    this.readingProgressDirty = false
    this.detailEl.scrollTop = 0
    this.applyReadingAppearance()
    this.readingContentReady = true
    this.updateReadingProgressUi()
    this.updateResumeButton()
    window.requestAnimationFrame(() => {
      if (generation !== this.detailGeneration) return
      this.suppressProgressTracking = false
      this.updateReadingProgressUi()
      this.updateResumeButton()
    })
  }

  private scheduleReadingProgressSave(): void {
    if (this.progressSaveTimer !== null) window.clearTimeout(this.progressSaveTimer)
    this.progressSaveTimer = window.setTimeout(() => {
      this.progressSaveTimer = null
      this.persistCurrentReadingProgress()
    }, 450)
  }

  private persistCurrentReadingProgress(): void {
    if (this.progressSaveTimer !== null) window.clearTimeout(this.progressSaveTimer)
    this.progressSaveTimer = null
    if (!this.readingContentReady || !this.readingProgressDirty || !this.detailEl) return
    const context = this.currentReadingContext()
    if (!context) return
    const position = {
      ...context,
      progress: normalizedReadingProgress(
        this.detailEl.scrollTop,
        this.detailEl.scrollHeight,
        this.detailEl.clientHeight,
      ),
      updatedAt: Date.now(),
    }
    this.readingProgressDirty = false
    void this.plugin.setReadingPosition(position).catch((error) => {
      new Notice(`无法保存阅读位置：${this.errorText(error)}`, 7000)
    })
  }

  private updateReadingProgressUi(): void {
    if (!this.progressFillEl || !this.progressTextEl || !this.progressTrackEl) return
    const progress = this.readingContentReady
      ? normalizedReadingProgress(this.detailEl.scrollTop, this.detailEl.scrollHeight, this.detailEl.clientHeight)
      : 0
    const percent = readingProgressPercent(progress)
    this.progressFillEl.style.width = `${percent}%`
    this.progressTextEl.setText(`${percent}%`)
    this.progressTrackEl.setAttribute('aria-valuenow', String(percent))
  }

  private updateResumeButton(): void {
    if (!this.resumeButtonEl) return
    const context = this.currentReadingContext()
    const contextId = context ? this.readingContextId(context.key, context.mode) : null
    const saved = context ? this.plugin.getReadingPosition(context.key, context.mode) : null
    const visible = Boolean(
      saved
      && saved.progress >= 0.02
      && saved.progress < 0.995
      && this.resumeDismissedContext !== contextId,
    )
    this.resumeButtonEl.toggleClass('is-hidden', !visible)
    if (visible && saved) {
      this.resumeButtonEl.setText(`返回上次位置（${readingProgressPercent(saved.progress)}%）`)
    }
  }

  private restoreReadingPosition(): void {
    const context = this.currentReadingContext()
    if (!context) return
    const saved = this.plugin.getReadingPosition(context.key, context.mode)
    if (!saved) return
    this.resumeDismissedContext = this.readingContextId(context.key, context.mode)
    this.suppressProgressTracking = true
    this.detailEl.scrollTop = scrollTopForProgress(
      saved.progress,
      this.detailEl.scrollHeight,
      this.detailEl.clientHeight,
    )
    this.updateReadingProgressUi()
    this.updateResumeButton()
    window.requestAnimationFrame(() => { this.suppressProgressTracking = false })
  }

  private currentReadingContext(): { key: ReadingMarkerKey; mode: ReadingViewMode } | null {
    if (!this.selected) return null
    if (this.selected.resource === 'notes') {
      return { key: noteMarkerKey(this.selected.id), mode: this.selectedNoteMode }
    }
    return {
      key: translationMarkerKey(this.selected.kind, this.selected.id),
      mode: this.selectedTranslationMode,
    }
  }

  private readingContextId(key: ReadingMarkerKey, mode: ReadingViewMode): string {
    return `${key}|${mode}`
  }

  private isNoteViewMode(mode: ReadingViewMode | undefined): mode is NoteViewMode {
    return mode === 'note' || mode === 'summary' || mode === 'reader' || mode === 'segments'
  }

  private isTranslationViewMode(mode: ReadingViewMode | undefined): mode is TranslationViewMode {
    return mode === 'translation-text' || mode === 'translation-segments'
  }

  private resetReadingUiState(): void {
    this.readingContentReady = false
    this.readingProgressDirty = false
    this.suppressProgressTracking = false
    this.previousButtonEl = null
    this.nextButtonEl = null
    this.progressFillEl = null
    this.progressTextEl = null
    this.progressTrackEl = null
    this.resumeButtonEl = null
  }

  private addExternalLink(parent: HTMLElement, href: string, label: string): void {
    parent.createEl('a', {
      text: label,
      href,
      attr: { target: '_blank', rel: 'noopener noreferrer' },
    })
  }

  private renderEmptyDetail(): void {
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    const empty = this.detailEl.createDiv({ cls: 'openrss-library__empty-detail' })
    empty.createEl('h3', { text: '选择一条资料开始阅读' })
    empty.createEl('p', { text: '正文和译文会按需从 OpenRSS 获取，仅保留在当前 Obsidian 进程内。' })
  }

  private renderLoadingDetail(): void {
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    this.detailEl.createDiv({ cls: 'openrss-library__empty-detail', text: '正在加载正文…' })
  }

  private renderDetailError(error: unknown): void {
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    const box = this.detailEl.createDiv({ cls: 'openrss-library__error' })
    box.createEl('h3', { text: '无法读取 OpenRSS 资料' })
    box.createEl('p', { text: this.errorText(error) })
    box.createEl('p', { text: '请检查插件设置中的 OpenRSS 地址和只读 Token。' })
  }

  private async refreshAll(): Promise<void> {
    const selection = this.selected
    this.cache.clear()
    this.assets.clear()
    await this.reload(false)
    if (!selection) return
    if (selection.resource === 'notes') await this.openNote(selection.id, this.selectedNoteMode)
    else await this.openTranslation(selection.kind, selection.id, this.selectedTranslationMode)
  }

  private noteTypeLabel(type: string): string {
    return type === 'tech_note' ? '技术笔记' : '论文笔记'
  }

  private formatDate(raw: string): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(new Date(raw))
    } catch {
      return raw
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private resetMarkdownScope(): Component {
    this.clearMarkdownScope()
    const component = new Component()
    this.markdownScope = this.addChild(component)
    return component
  }

  private clearMarkdownScope(): void {
    if (!this.markdownScope) return
    this.removeChild(this.markdownScope)
    this.markdownScope = null
  }
}
