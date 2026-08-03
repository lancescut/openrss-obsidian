import { Component, ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian'

import type OpenRssLibraryPlugin from '../main'
import type {
  NoteDetail,
  NoteFacets,
  NoteListItem,
  NoteListPage,
  LibraryReadState,
  LibraryResourceState,
  LibraryTag,
  SubscriptionFacet,
  TranslationDetail,
  TranslationKind,
  TranslationListItem,
  TranslationListPage,
} from '../api/types'
import { jsonWeight, MemoryLru } from '../memory-cache'
import {
  LongPressGesture,
  LONG_PRESS_MOVE_TOLERANCE,
  LONG_PRESS_MS,
} from '../long-press'
import type { ReadingViewMode } from '../plugin-state'
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
type NoteViewMode = 'note'
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
  private noteSubscriptionId: number | null = null
  private translationSubscriptionId: number | null = null
  private targetLang = ''
  private favoriteOnly = false
  private readLaterOnly = false
  private readState: LibraryReadState | null = null
  private tagId: number | null = null
  private tags: LibraryTag[] = []
  private libraryStateWrite = false
  private changesCursor = 0
  private entries: ListEntry[] = []
  private nextCursor: string | null = null
  private total = 0
  private noteFacets: NoteFacets | null = null
  private translationSubscriptionFacets: SubscriptionFacet[] = []
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
  private currentResourceId: number | null = null
  private currentContentRevision: string | null = null
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
  private stateActionsParentEl: HTMLElement | null = null
  private stateActionsEl: HTMLElement | null = null

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
      if (!document.hidden) void this.pollLibraryChanges()
    }, 45_000))
    try {
      await this.plugin.migrateLegacyStateIfNeeded()
      const [capabilities, tags] = await Promise.all([
        this.plugin.createClient().capabilities(),
        this.plugin.createClient().tags(),
      ])
      this.libraryStateWrite = capabilities.features.library_state_write
      this.tags = tags
      const baseline = await this.plugin.createClient().changes(0)
      this.changesCursor = baseline.latest_cursor
      this.renderFilters()
    } catch (error) {
      new Notice(`OpenRSS 状态同步初始化失败：${this.errorText(error)}`, 7000)
    }
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
      for (const row of this.noteFacets?.subscriptions || []) {
        subscriptions.push([String(row.id), `${row.name || `#${row.id}`} (${row.count})`])
      }
      this.addSelect(this.filtersEl, '订阅', this.noteSubscriptionId ? String(this.noteSubscriptionId) : '', subscriptions, (value) => {
        this.noteSubscriptionId = value ? Number(value) : null
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
      const subscriptions: Array<[string, string]> = [['', '全部来源']]
      for (const row of this.translationSubscriptionFacets) {
        subscriptions.push([String(row.id), `${row.name || `#${row.id}`} (${row.count})`])
      }
      this.addSelect(
        this.filtersEl,
        '订阅',
        this.translationSubscriptionId ? String(this.translationSubscriptionId) : '',
        subscriptions,
        (value) => {
          this.translationSubscriptionId = value ? Number(value) : null
          void this.reload(true)
        },
      )
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
    this.addSelect(this.filtersEl, '阅读状态', this.readState || '', [
      ['', '全部阅读状态'],
      ['unread', '未读'],
      ['reading', '阅读中'],
      ['read', '已读'],
    ], (value) => {
      this.readState = value ? value as LibraryReadState : null
      void this.reload(true)
    })
    const tagOptions: Array<[string, string]> = [['', '全部标签']]
    for (const tag of this.tags) tagOptions.push([String(tag.id), tag.name])
    this.addSelect(this.filtersEl, '标签', this.tagId ? String(this.tagId) : '', tagOptions, (value) => {
      this.tagId = value ? Number(value) : null
      void this.reload(true)
    })
    this.addFilterToggle('收藏', this.favoriteOnly, (checked) => {
      this.favoriteOnly = checked
      void this.reload(true)
    })
    this.addFilterToggle('稍后读', this.readLaterOnly, (checked) => {
      this.readLaterOnly = checked
      void this.reload(true)
    })
  }

  private addFilterToggle(label: string, checked: boolean, onChange: (checked: boolean) => void): void {
    const wrapper = this.filtersEl.createEl('label', { cls: 'openrss-library__filter-toggle' })
    const input = wrapper.createEl('input', { attr: { type: 'checkbox' } })
    input.checked = checked
    wrapper.createSpan({ text: label })
    input.addEventListener('change', () => onChange(input.checked))
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
    this.splitterEl.addEventListener('lostpointercapture', (event) => {
      if (activePointerId === event.pointerId) finishResize(event)
    })
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
          subscriptionId: this.noteSubscriptionId,
          favorite: this.favoriteOnly || null,
          readLater: this.readLaterOnly || null,
          readState: this.readState,
          tagId: this.tagId,
        })
        : await this.plugin.createClient().translations({
          kind: this.translationKind,
          limit: 50,
          q: this.query,
          targetLang: this.targetLang,
          subscriptionId: this.translationSubscriptionId,
          favorite: this.favoriteOnly || null,
          readLater: this.readLaterOnly || null,
          readState: this.readState,
          tagId: this.tagId,
        })
      if (generation !== this.listGeneration) return
      if (this.resource === 'notes') {
        this.noteFacets = (page as NoteListPage).facets
      } else {
        this.translationSubscriptionFacets = (page as TranslationListPage).facets.subscriptions
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
          subscriptionId: this.noteSubscriptionId,
          favorite: this.favoriteOnly || null,
          readLater: this.readLaterOnly || null,
          readState: this.readState,
          tagId: this.tagId,
        })
        : await this.plugin.createClient().translations({
          kind: this.translationKind,
          cursor,
          limit: 50,
          q: this.query,
          targetLang: this.targetLang,
          subscriptionId: this.translationSubscriptionId,
          favorite: this.favoriteOnly || null,
          readLater: this.readLaterOnly || null,
          readState: this.readState,
          tagId: this.tagId,
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
      const state = entry.value.library_state
      const marked = state?.read_state === 'reading'
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
      if (state?.read_state === 'read') titleRow.createSpan({ cls: 'openrss-library__reading-badge', text: '已读' })
      if (state?.favorite) titleRow.createSpan({ cls: 'openrss-library__state-badge', text: '★' })
      if (state?.read_later) titleRow.createSpan({ cls: 'openrss-library__state-badge', text: '稍后读' })
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
    const resourceId = entry.value.resource_id
    const state = entry.value.library_state
    const menu = new Menu()
    if (!resourceId || !state) {
      menu.addItem((item) => item.setTitle('这条资料暂不支持状态操作').setDisabled(true))
      menu.showAtPosition({ x, y })
      return
    }
    menu.addItem((item) => item
      .setTitle(state.favorite ? '取消收藏' : '收藏')
      .setIcon(state.favorite ? 'star-off' : 'star')
      .onClick(() => void this.updateEntryState(entry, 'favorite', !state.favorite)))
    menu.addItem((item) => item
      .setTitle(state.read_later ? '移出稍后读' : '加入稍后读')
      .setIcon(state.read_later ? 'bookmark-x' : 'bookmark')
      .onClick(() => void this.updateEntryState(entry, 'read-later', !state.read_later)))
    menu.addSeparator()
    for (const [readState, label] of [
      ['unread', '标记为未读'],
      ['reading', '标记为阅读中'],
      ['read', '标记为已读'],
    ] as const) {
      menu.addItem((item) => item
        .setTitle(label)
        .setChecked(state.read_state === readState)
        .onClick(() => void this.updateEntryState(entry, 'read-state', readState)))
    }
    if (this.tags.length) menu.addSeparator()
    for (const tag of this.tags) {
      const assigned = state.tags.some((value) => value.id === tag.id)
      menu.addItem((item) => item
        .setTitle(`${assigned ? '移除' : '添加'}标签：${tag.name}`)
        .setIcon('tag')
        .setChecked(assigned)
        .onClick(() => void this.updateEntryState(entry, 'tag', { tagId: tag.id, value: !assigned })))
    }
    menu.showAtPosition({ x, y })
  }

  private async updateEntryState(
    entry: ListEntry,
    action: 'favorite' | 'read-later' | 'read-state' | 'tag',
    value: boolean | LibraryReadState | { tagId: number; value: boolean },
  ): Promise<void> {
    const resourceId = entry.value.resource_id
    if (!resourceId || !this.libraryStateWrite) {
      new Notice('此令牌未启用资料状态同步；请在 OpenRSS 设置中开启。', 7000)
      return
    }
    try {
      const client = this.plugin.createClient()
      let state: LibraryResourceState
      if (action === 'favorite') state = await client.setFavorite(resourceId, Boolean(value))
      else if (action === 'read-later') state = await client.setReadLater(resourceId, Boolean(value))
      else if (action === 'read-state') state = await client.setReadState(resourceId, value as LibraryReadState)
      else {
        const tag = value as { tagId: number; value: boolean }
        state = await client.setTag(resourceId, tag.tagId, tag.value)
      }
      entry.value.library_state = state
      this.renderVirtualRows()
    } catch (error) {
      new Notice(`无法保存资料状态：${this.errorText(error)}`, 7000)
    }
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
    this.selectedNoteMode = preferredMode || 'note'
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
      this.currentResourceId = detail.resource_id
      this.currentContentRevision = detail.content_revision
      if (detail.resource_id) {
        this.plugin.hydrateResourceState(detail.resource_id, detail.library_state)
        const latestMode = this.plugin.getLatestReadingPosition(detail.resource_id)?.mode
        if (!preferredMode && this.isNoteViewMode(latestMode)) this.selectedNoteMode = latestMode
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
    this.selectedTranslationMode = preferredMode || 'translation-text'
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
      this.currentResourceId = detail.resource_id
      this.currentContentRevision = detail.content_revision
      if (detail.resource_id) {
        this.plugin.hydrateResourceState(detail.resource_id, detail.library_state)
        const latestMode = this.plugin.getLatestReadingPosition(detail.resource_id)?.mode
        if (!preferredMode && this.isTranslationViewMode(latestMode)) {
          this.selectedTranslationMode = latestMode
        }
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
    if (detail.resource_id && detail.library_state) {
      this.renderResourceStateActions(heading, detail.resource_id, detail.library_state)
    }

    this.renderRelatedTranslations(detail)
    const content = this.detailEl.createDiv({ cls: 'openrss-library__markdown markdown-rendered' })
    await this.renderNoteBody(content, detail, generation)
    this.finishReadingContent(generation)
  }

  private renderRelatedTranslations(detail: NoteDetail): void {
    if (!detail.translations.summary.length && !detail.translations.reader.length) return
    const related = this.detailEl.createDiv({ cls: 'openrss-library__related-resources' })
    related.createSpan({ text: '关联翻译：' })
    for (const translation of detail.translations.summary) {
      const label = `摘要翻译 · ${translation.target_lang} · ${translation.model}`
      const button = related.createEl('button', {
        text: label,
        attr: { type: 'button', 'aria-label': `打开${label}` },
      })
      button.addEventListener('click', () => {
        void this.openTranslation('summary', translation.id, 'translation-text')
      })
    }
    for (const translation of detail.translations.reader) {
      const segmentHint = translation.translated_segments?.length ? ' · 含段落对照' : ''
      const label = `全文翻译 · ${translation.target_lang} · ${translation.source_mode}${segmentHint}`
      const button = related.createEl('button', {
        text: label,
        attr: { type: 'button', 'aria-label': `打开${label}` },
      })
      button.addEventListener('click', () => {
        void this.openTranslation('reader', translation.id)
      })
    }
  }

  private async renderNoteBody(
    container: HTMLElement,
    detail: NoteDetail,
    generation: number,
  ): Promise<void> {
    const contentGeneration = ++this.contentGeneration
    const markdownOwner = this.resetMarkdownScope()
    container.empty()
    this.assets.clear()
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
    if (detail.resource_id && detail.library_state) {
      this.renderResourceStateActions(heading, detail.resource_id, detail.library_state)
    }

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
      const textButton = tabs.createEl('button', { cls: 'openrss-library__tab', text: '全文译文', attr: { type: 'button' } })
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

  private renderResourceStateActions(
    parent: HTMLElement,
    resourceId: number,
    initialState: LibraryResourceState,
  ): void {
    if (this.stateActionsParentEl === parent) this.stateActionsEl?.remove()
    const actions = parent.createDiv({ cls: 'openrss-library__state-actions' })
    this.stateActionsParentEl = parent
    this.stateActionsEl = actions
    const render = (state: LibraryResourceState) => {
      actions.empty()
      const mutate = async (
        operation: () => Promise<LibraryResourceState>,
      ) => {
        if (!this.libraryStateWrite) {
          new Notice('此令牌未启用资料状态同步；请在 OpenRSS 设置中开启。', 7000)
          return
        }
        for (const control of Array.from(actions.querySelectorAll('button, select'))) {
          (control as HTMLButtonElement | HTMLSelectElement).disabled = true
        }
        try {
          const next = await operation()
          for (const entry of this.entries) {
            if (entry.value.resource_id === resourceId) entry.value.library_state = next
          }
          this.plugin.hydrateResourceState(resourceId, next)
          this.renderVirtualRows()
          render(next)
        } catch (error) {
          new Notice(`无法保存资料状态：${this.errorText(error)}`, 7000)
          render(state)
        }
      }
      const favorite = actions.createEl('button', {
        text: state.favorite ? '★ 已收藏' : '☆ 收藏',
        cls: state.favorite ? 'is-active' : '',
        attr: { type: 'button' },
      })
      favorite.disabled = !this.libraryStateWrite
      favorite.addEventListener('click', () => void mutate(
        () => this.plugin.createClient().setFavorite(resourceId, !state.favorite),
      ))
      const later = actions.createEl('button', {
        text: state.read_later ? '✓ 稍后读' : '稍后读',
        cls: state.read_later ? 'is-active' : '',
        attr: { type: 'button' },
      })
      later.disabled = !this.libraryStateWrite
      later.addEventListener('click', () => void mutate(
        () => this.plugin.createClient().setReadLater(resourceId, !state.read_later),
      ))
      const readState = actions.createEl('select', { attr: { 'aria-label': '阅读状态' } })
      for (const [value, label] of [
        ['unread', '未读'],
        ['reading', '阅读中'],
        ['read', '已读'],
      ] as const) {
        const option = readState.createEl('option', { value, text: label })
        option.selected = state.read_state === value
      }
      readState.disabled = !this.libraryStateWrite
      readState.addEventListener('change', () => void mutate(
        () => this.plugin.createClient().setReadState(
          resourceId,
          readState.value as LibraryReadState,
        ),
      ))
      for (const tag of state.tags) {
        const chip = actions.createEl('button', {
          text: `#${tag.name} ×`,
          cls: 'openrss-library__tag-chip',
          attr: { type: 'button', title: `移除标签 ${tag.name}` },
        })
        chip.disabled = !this.libraryStateWrite
        chip.addEventListener('click', () => void mutate(
          () => this.plugin.createClient().setTag(resourceId, tag.id, false),
        ))
      }
      const assigned = new Set(state.tags.map((tag) => tag.id))
      const available = this.tags.filter((tag) => !assigned.has(tag.id))
      if (available.length) {
        const addTag = actions.createEl('select', { attr: { 'aria-label': '添加标签' } })
        addTag.createEl('option', { value: '', text: '添加标签…' })
        for (const tag of available) addTag.createEl('option', { value: String(tag.id), text: tag.name })
        addTag.disabled = !this.libraryStateWrite
        addTag.addEventListener('change', () => {
          if (!addTag.value) return
          void mutate(() => this.plugin.createClient().setTag(resourceId, Number(addTag.value), true))
        })
      }
      if (!this.libraryStateWrite) {
        actions.createSpan({ cls: 'openrss-library__state-readonly', text: '状态同步未授权' })
      }
    }
    render(initialState)
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
    this.resumeDismissedContext = this.readingContextId(context.resourceId, context.mode)
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
    const contextId = context ? this.readingContextId(context.resourceId, context.mode) : null
    const saved = context ? this.plugin.getReadingPosition(context.resourceId, context.mode) : null
    const visible = Boolean(
      saved
      && saved.progress >= 0.02
      && saved.progress < 0.995
      && this.resumeDismissedContext !== contextId,
    )
    this.resumeButtonEl.toggleClass('is-hidden', !visible)
    if (visible && saved) {
      const changed = saved.contentRevision === null
        || saved.contentRevision !== context?.contentRevision
      this.resumeButtonEl.setText(changed
        ? `内容已更新，确认返回旧位置（${readingProgressPercent(saved.progress)}%）`
        : `返回上次位置（${readingProgressPercent(saved.progress)}%）`)
    }
  }

  private restoreReadingPosition(): void {
    const context = this.currentReadingContext()
    if (!context) return
    const saved = this.plugin.getReadingPosition(context.resourceId, context.mode)
    if (!saved) return
    this.resumeDismissedContext = this.readingContextId(context.resourceId, context.mode)
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

  private currentReadingContext(): {
    resourceId: number
    contentRevision: string | null
    mode: ReadingViewMode
  } | null {
    if (!this.selected || !this.currentResourceId) return null
    return {
      resourceId: this.currentResourceId,
      contentRevision: this.currentContentRevision,
      mode: this.selected.resource === 'notes'
        ? this.selectedNoteMode
        : this.selectedTranslationMode,
    }
  }

  private readingContextId(resourceId: number, mode: ReadingViewMode): string {
    return `${resourceId}|${mode}`
  }

  private isNoteViewMode(mode: ReadingViewMode | undefined): mode is NoteViewMode {
    return mode === 'note'
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
    this.currentResourceId = null
    this.currentContentRevision = null
    this.stateActionsParentEl = null
    this.stateActionsEl = null
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    const empty = this.detailEl.createDiv({ cls: 'openrss-library__empty-detail' })
    empty.createEl('h3', { text: '选择一条资料开始阅读' })
    empty.createEl('p', { text: '正文和译文会按需从 OpenRSS 获取，仅保留在当前 Obsidian 进程内。' })
  }

  private renderLoadingDetail(): void {
    this.currentResourceId = null
    this.currentContentRevision = null
    this.stateActionsParentEl = null
    this.stateActionsEl = null
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    this.detailEl.createDiv({ cls: 'openrss-library__empty-detail', text: '正在加载正文…' })
  }

  private renderDetailError(error: unknown): void {
    this.currentResourceId = null
    this.currentContentRevision = null
    this.stateActionsParentEl = null
    this.stateActionsEl = null
    this.clearMarkdownScope()
    this.resetReadingUiState()
    this.detailEl.empty()
    const box = this.detailEl.createDiv({ cls: 'openrss-library__error' })
    box.createEl('h3', { text: '无法读取 OpenRSS 资料' })
    box.createEl('p', { text: this.errorText(error) })
    box.createEl('p', { text: '请检查插件设置中的 OpenRSS 地址和 Token。' })
  }

  private async pollLibraryChanges(): Promise<void> {
    try {
      const page = await this.plugin.createClient().changes(this.changesCursor)
      this.changesCursor = page.cursor
      if (page.expired) {
        this.changesCursor = page.latest_cursor
        await this.refreshAll()
        return
      }
      if (!page.changes.length) return
      const selectedResourceChanged = this.currentResourceId != null
        && page.changes.some((change) => change.resource_id === this.currentResourceId)
      if (selectedResourceChanged && this.currentResourceId) {
        const state = await this.plugin.createClient().resourceState(this.currentResourceId)
        this.plugin.hydrateResourceState(this.currentResourceId, state)
        for (const entry of this.entries) {
          if (entry.value.resource_id === this.currentResourceId) entry.value.library_state = state
        }
        if (this.stateActionsParentEl) {
          this.renderResourceStateActions(this.stateActionsParentEl, this.currentResourceId, state)
        }
        this.updateResumeButton()
      }
      await this.reload(false)
    } catch (error) {
      if (!document.hidden) {
        new Notice(`OpenRSS 状态同步暂时失败：${this.errorText(error)}`, 5000)
      }
    }
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
