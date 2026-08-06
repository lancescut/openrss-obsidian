export type Envelope<T> = {
  ok: boolean
  data: T
  error: { code: string; message: string; detail?: Record<string, unknown> } | null
  request_id: string
}

export type Capabilities = {
  api_version: number
  user: { id: number; username: string }
  features: {
    note_search: boolean
    summary_translation: boolean
    reader_translation: boolean
    translation_segments: boolean
    knowledge_graph_links: boolean
    write: false
    content_write: false
    library_state_read: boolean
    library_state_write: boolean
    library_state_changes: boolean
  }
}

export type LibraryReadState = 'unread' | 'reading' | 'read'
export type LibrarySortOrder = 'desc' | 'asc'

export type LibraryTag = {
  id: number
  name: string
  color: string | null
}

export type LibraryReadingPosition = {
  view_mode: string
  content_revision: string | null
  progress: number
  revision: number
  updated_at: string | null
}

export type LibraryResourceState = {
  favorite: boolean
  favorited_at: string | null
  read_later: boolean
  read_later_at: string | null
  read_state: LibraryReadState
  tags: LibraryTag[]
  revision: number
  updated_at: string | null
  positions?: LibraryReadingPosition[]
}

export type NoteListItem = {
  id: number
  resource_id: number | null
  content_revision: string | null
  library_state: LibraryResourceState | null
  title: string
  summary: string | null
  status: string
  note_type: 'paper_note' | 'tech_note'
  updated_at: string
  item: { id: number; title: string; url: string }
  subscription: { id: number | null; name: string | null; deleted: boolean }
  snippet: string | null
}

export type SubscriptionFacet = { id: number; name: string | null; count: number }

export type NoteFacets = {
  status: Record<string, number>
  note_type: Record<string, number>
  subscriptions: SubscriptionFacet[]
}

export type NoteListPage = {
  items: NoteListItem[]
  next_cursor: string | null
  total: number
  facets: NoteFacets
}

export type TranslationKind = 'summary' | 'reader'

export type TranslationListItem = {
  id: number
  resource_id: number | null
  content_revision: string
  library_state: LibraryResourceState | null
  kind: TranslationKind
  target_lang: string
  source_language: string
  source_mode: string
  provider: string
  model: string
  prompt_version: string
  source_hash: string | null
  char_count: number
  updated_at: string
  item: { id: number; title: string; url: string }
  note_ids: number[]
}

export type TranslationListPage = {
  items: TranslationListItem[]
  next_cursor: string | null
  total: number
  facets: { subscriptions: SubscriptionFacet[] }
}

export type TranslationSegment = { src: string; trans: string }

export type TranslationDetail = TranslationListItem & {
  source_hash: string
  translated_text: string
  translated_segments: TranslationSegment[] | null
  revision: string
}

export type SummaryTranslation = {
  id: number
  target_lang: string
  source_language: string
  translated_text: string
  provider: string
  model: string
  updated_at: string
}

export type ReaderTranslation = SummaryTranslation & {
  source_mode: string
  translated_segments: TranslationSegment[] | null
  source_hash: string
}

export type NoteAsset = {
  filename: string
  markdown_path: string
  mime: string
  size_bytes: number
}

export type NoteDetail = {
  revision: string
  resource_id: number | null
  content_revision: string | null
  library_state: LibraryResourceState | null
  note: {
    id: number
    title: string
    summary: string | null
    body_md: string | null
    status: string
    note_type: 'paper_note' | 'tech_note'
    prompt_version: string
    updated_at: string
  }
  item: { id: number; title: string; url: string; published_at: string | null }
  subscription: { id: number | null; name: string | null; deleted: boolean }
  translations: {
    summary: SummaryTranslation[]
    reader: ReaderTranslation[]
  }
  assets: NoteAsset[]
  links: { openrss: string; source: string }
}

export type ConditionalResult<T> =
  | { notModified: true; data: null; etag: string | null }
  | { notModified: false; data: T; etag: string | null }

export type LibraryStateChangePage = {
  expired: boolean
  cursor: number
  latest_cursor: number
  changes: Array<{
    id: number
    resource_id: number
    change_kind: 'state' | 'tags' | 'position'
    revision: number
    changed_at: string
  }>
}

export type LocalStateImportResult = {
  results: Array<{
    type: 'marker' | 'position'
    key: string
    mode?: string
    status: 'imported' | 'skipped' | 'failed'
    reason?: string
  }>
  imported: number
  skipped: number
  failed: number
}
