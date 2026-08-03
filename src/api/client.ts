import { App, RequestUrlParam, RequestUrlResponse, requestUrl } from 'obsidian'

import type {
  Capabilities,
  ConditionalResult,
  Envelope,
  LibraryReadState,
  LibraryReadingPosition,
  LibraryResourceState,
  LibraryStateChangePage,
  LibraryTag,
  LocalStateImportResult,
  NoteDetail,
  NoteListPage,
  TranslationDetail,
  TranslationKind,
  TranslationListPage,
} from './types'
import { normalizeBaseUrl } from './url'
import { nonJsonResponseMessage } from './response'

export { normalizeBaseUrl } from './url'


export type ConnectionSettings = {
  baseUrl: string
  secretName: string
}


export class OpenRssApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OpenRssApiError'
  }
}


export class OpenRssClient {
  constructor(
    private readonly app: App,
    private readonly settings: ConnectionSettings,
  ) {}

  async capabilities(): Promise<Capabilities> {
    return this.get('/api/v1/integrations/obsidian/capabilities')
  }

  async notes(params: {
    cursor?: string | null
    limit?: number
    q?: string
    status?: string | null
    noteType?: string | null
    subscriptionId?: number | null
    favorite?: boolean | null
    readLater?: boolean | null
    readState?: LibraryReadState | null
    tagId?: number | null
  }): Promise<NoteListPage> {
    return this.get('/api/v1/integrations/obsidian/notes', {
      cursor: params.cursor,
      limit: params.limit ?? 50,
      q: params.q,
      status: params.status,
      note_type: params.noteType,
      subscription_id: params.subscriptionId,
      favorite: params.favorite,
      read_later: params.readLater,
      read_state: params.readState,
      tag_id: params.tagId,
    })
  }

  async note(noteId: number, etag?: string | null): Promise<ConditionalResult<NoteDetail>> {
    return this.getConditional(`/api/v1/integrations/obsidian/notes/${noteId}`, etag)
  }

  async translations(params: {
    kind: TranslationKind
    cursor?: string | null
    limit?: number
    q?: string
    targetLang?: string
    subscriptionId?: number | null
    favorite?: boolean | null
    readLater?: boolean | null
    readState?: LibraryReadState | null
    tagId?: number | null
  }): Promise<TranslationListPage> {
    return this.get('/api/v1/integrations/obsidian/translations', {
      kind: params.kind,
      cursor: params.cursor,
      limit: params.limit ?? 50,
      q: params.q,
      target_lang: params.targetLang,
      subscription_id: params.subscriptionId,
      favorite: params.favorite,
      read_later: params.readLater,
      read_state: params.readState,
      tag_id: params.tagId,
    })
  }

  async translation(
    kind: TranslationKind,
    translationId: number,
    etag?: string | null,
  ): Promise<ConditionalResult<TranslationDetail>> {
    return this.getConditional(
      `/api/v1/integrations/obsidian/translations/${kind}/${translationId}`,
      etag,
    )
  }

  async asset(noteId: number, filename: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const response = await this.request(
      `/api/v1/integrations/obsidian/notes/${noteId}/assets/${encodeURIComponent(filename)}`,
    )
    return {
      bytes: response.arrayBuffer,
      contentType: this.header(response.headers, 'content-type') || 'application/octet-stream',
    }
  }

  async resourceState(resourceId: number): Promise<LibraryResourceState> {
    return this.get(`/api/v1/integrations/obsidian/library/resources/${resourceId}/state`)
  }

  async setFavorite(resourceId: number, value: boolean): Promise<LibraryResourceState> {
    return this.mutate(
      value ? 'PUT' : 'DELETE',
      `/api/v1/integrations/obsidian/library/resources/${resourceId}/favorite`,
    )
  }

  async setReadLater(resourceId: number, value: boolean): Promise<LibraryResourceState> {
    return this.mutate(
      value ? 'PUT' : 'DELETE',
      `/api/v1/integrations/obsidian/library/resources/${resourceId}/read-later`,
    )
  }

  async setReadState(
    resourceId: number,
    readState: LibraryReadState,
  ): Promise<LibraryResourceState> {
    return this.mutate(
      'PUT',
      `/api/v1/integrations/obsidian/library/resources/${resourceId}/read-state`,
      { read_state: readState },
    )
  }

  async tags(): Promise<LibraryTag[]> {
    return this.get('/api/v1/integrations/obsidian/tags')
  }

  async createTag(name: string): Promise<LibraryTag> {
    return this.mutate('POST', '/api/v1/integrations/obsidian/tags', { name })
  }

  async setTag(resourceId: number, tagId: number, value: boolean): Promise<LibraryResourceState> {
    return this.mutate(
      value ? 'PUT' : 'DELETE',
      `/api/v1/integrations/obsidian/library/resources/${resourceId}/tags/${tagId}`,
    )
  }

  async setPosition(
    resourceId: number,
    viewMode: string,
    body: { progress: number; content_revision: string | null; expected_revision: number },
  ): Promise<LibraryReadingPosition> {
    return this.mutate(
      'PUT',
      `/api/v1/integrations/obsidian/library/resources/${resourceId}/positions/${encodeURIComponent(viewMode)}`,
      body,
    )
  }

  async changes(after: number): Promise<LibraryStateChangePage> {
    return this.get('/api/v1/integrations/obsidian/library/changes', { after })
  }

  async importLocalState(body: {
    markers: string[]
    positions: Array<{ key: string; mode: string; progress: number; updatedAt: number }>
  }): Promise<LocalStateImportResult> {
    return this.mutate(
      'POST',
      '/api/v1/integrations/obsidian/library/import-local-state',
      body,
    )
  }

  openRssWebUrl(path: string): string {
    return this.url(path)
  }

  private token(): string {
    const name = this.settings.secretName.trim()
    const token = name ? this.app.secretStorage.getSecret(name) : null
    if (!token) {
      throw new Error('请先在插件设置中选择或创建 OpenRSS Token 密钥')
    }
    return token
  }

  private url(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
    const baseUrl = normalizeBaseUrl(this.settings.baseUrl)
    const url = new URL(path, `${baseUrl}/`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<T> {
    const response = await this.request(path, query)
    const envelope = this.envelope<T>(response)
    if (!envelope?.ok) {
      throw new OpenRssApiError(envelope?.error?.message || `HTTP ${response.status}`, response.status)
    }
    return envelope.data
  }

  private async mutate<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(path, undefined, undefined, method, body)
    const envelope = this.envelope<T>(response)
    if (!envelope?.ok) {
      throw new OpenRssApiError(
        envelope?.error?.message || `HTTP ${response.status}`,
        response.status,
        envelope?.error?.code,
        envelope?.error?.detail,
      )
    }
    return envelope.data
  }

  private async getConditional<T>(
    path: string,
    etag?: string | null,
  ): Promise<ConditionalResult<T>> {
    const response = await this.request(path, undefined, etag ? { 'If-None-Match': etag } : undefined)
    const returnedEtag = this.header(response.headers, 'etag')
    if (response.status === 304) {
      return { notModified: true, data: null, etag: returnedEtag || etag || null }
    }
    const envelope = this.envelope<T>(response)
    if (!envelope?.ok) {
      throw new OpenRssApiError(envelope?.error?.message || `HTTP ${response.status}`, response.status)
    }
    return { notModified: false, data: envelope.data, etag: returnedEtag }
  }

  private async request(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
    extraHeaders?: Record<string, string>,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
  ) {
    const params: RequestUrlParam = {
      url: this.url(path, query),
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${this.token()}`,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    }
    const response = await requestUrl(params)
    if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
      const envelope = this.envelope<unknown>(response)
      throw new OpenRssApiError(
        envelope?.error?.message || `OpenRSS 请求失败（HTTP ${response.status}）`,
        response.status,
        envelope?.error?.code,
        envelope?.error?.detail,
      )
    }
    return response
  }

  private envelope<T>(response: RequestUrlResponse): Envelope<T> {
    try {
      return response.json as Envelope<T>
    } catch {
      throw new OpenRssApiError(
        nonJsonResponseMessage(
          response.status,
          this.header(response.headers, 'content-type'),
          response.text,
        ),
        response.status,
      )
    }
  }

  private header(headers: Record<string, string>, name: string): string | null {
    const wanted = name.toLowerCase()
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)
    return match?.[1] || null
  }
}
