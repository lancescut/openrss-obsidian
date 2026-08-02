export type Envelope<T> = {
  ok: boolean
  data: T
  error: { code: string; message: string } | null
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
  }
}

export type NoteListItem = {
  id: number
  title: string
  summary: string | null
  status: string
  note_type: 'paper_note' | 'tech_note'
  updated_at: string
  item: { id: number; title: string; url: string }
  subscription: { id: number; name: string | null }
  snippet: string | null
}

export type NoteFacets = {
  status: Record<string, number>
  note_type: Record<string, number>
  subscriptions: Array<{ id: number; name: string | null; count: number }>
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
  subscription: { id: number; name: string | null }
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
