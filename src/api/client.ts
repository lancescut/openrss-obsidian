import { App, RequestUrlParam, RequestUrlResponse, requestUrl } from 'obsidian'

import type {
  Capabilities,
  ConditionalResult,
  Envelope,
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
  constructor(message: string, readonly status: number) {
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
  }): Promise<NoteListPage> {
    return this.get('/api/v1/integrations/obsidian/notes', {
      cursor: params.cursor,
      limit: params.limit ?? 50,
      q: params.q,
      status: params.status,
      note_type: params.noteType,
      subscription_id: params.subscriptionId,
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
  }): Promise<TranslationListPage> {
    return this.get('/api/v1/integrations/obsidian/translations', {
      kind: params.kind,
      cursor: params.cursor,
      limit: params.limit ?? 50,
      q: params.q,
      target_lang: params.targetLang,
      subscription_id: params.subscriptionId,
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

  private url(path: string, query?: Record<string, string | number | null | undefined>): string {
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
    query?: Record<string, string | number | null | undefined>,
  ): Promise<T> {
    const response = await this.request(path, query)
    const envelope = this.envelope<T>(response)
    if (!envelope?.ok) {
      throw new OpenRssApiError(envelope?.error?.message || `HTTP ${response.status}`, response.status)
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
    query?: Record<string, string | number | null | undefined>,
    extraHeaders?: Record<string, string>,
  ) {
    const params: RequestUrlParam = {
      url: this.url(path, query),
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token()}`,
        ...extraHeaders,
      },
      throw: false,
    }
    const response = await requestUrl(params)
    if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
      const envelope = this.envelope<unknown>(response)
      throw new OpenRssApiError(
        envelope?.error?.message || `OpenRSS 请求失败（HTTP ${response.status}）`,
        response.status,
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
