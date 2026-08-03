import type { TranslationKind } from './api/types'


export type ReadingMarkerKey =
  | `note:${number}`
  | `translation:${TranslationKind}:${number}`

export type ReadingViewMode =
  | 'note'
  | 'summary'
  | 'reader'
  | 'segments'
  | 'translation-text'
  | 'translation-segments'

export type ReadingPosition = {
  key: ReadingMarkerKey
  mode: ReadingViewMode
  progress: number
  updatedAt: number
}

export type ReadingAppearance = {
  fontSize: number
  lineHeight: number
  maxWidth: number
}

export type FailedLegacyState = {
  type: 'marker' | 'position'
  key: string
  mode?: string
  reason?: string
  retainedForVersion: number
}

export type StoredPluginData = {
  baseUrl: string
  secretName: string
  readingMarkers: ReadingMarkerKey[]
  listPaneWidth: number | null
  readingPositions: ReadingPosition[]
  readingAppearance: ReadingAppearance
  stateMigrationVersion: number
  failedLegacyState: FailedLegacyState[]
}

export const CURRENT_STATE_MIGRATION_VERSION = 1

export const DEFAULT_READING_APPEARANCE: ReadingAppearance = {
  fontSize: 16,
  lineHeight: 1.7,
  maxWidth: 920,
}

export const DEFAULT_PLUGIN_DATA: StoredPluginData = {
  baseUrl: 'http://127.0.0.1:8787',
  secretName: '',
  readingMarkers: [],
  listPaneWidth: null,
  readingPositions: [],
  readingAppearance: { ...DEFAULT_READING_APPEARANCE },
  stateMigrationVersion: 0,
  failedLegacyState: [],
}

const READING_MARKER_PATTERN = /^(?:note:[1-9]\d*|translation:(?:summary|reader):[1-9]\d*)$/
const READING_MODE_PATTERN = /^(?:note|summary|reader|segments|translation-text|translation-segments)$/
const MIN_LIST_PANE_WIDTH = 28
const MAX_STORED_LIST_PANE_WIDTH = 1600
const MAX_READING_POSITIONS = 500

export const READING_APPEARANCE_LIMITS = {
  fontSize: { min: 14, max: 26 },
  lineHeight: { min: 1.4, max: 2.2 },
  maxWidth: { min: 560, max: 1200 },
} as const


export function noteMarkerKey(noteId: number): ReadingMarkerKey {
  return `note:${noteId}`
}

export function translationMarkerKey(
  kind: TranslationKind,
  translationId: number,
): ReadingMarkerKey {
  return `translation:${kind}:${translationId}`
}

export function normalizeStoredPluginData(raw: unknown): StoredPluginData {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const markers = Array.isArray(value.readingMarkers)
    ? value.readingMarkers.filter((marker): marker is ReadingMarkerKey => (
      typeof marker === 'string' && READING_MARKER_PATTERN.test(marker)
    ))
    : []
  const width = typeof value.listPaneWidth === 'number' && Number.isFinite(value.listPaneWidth)
    ? Math.round(value.listPaneWidth)
    : null
  const positions = normalizeReadingPositions(value.readingPositions)
  const appearance = normalizeReadingAppearance(value.readingAppearance)
  const stateMigrationVersion = typeof value.stateMigrationVersion === 'number'
    && Number.isInteger(value.stateMigrationVersion)
    && value.stateMigrationVersion >= 0
    ? value.stateMigrationVersion
    : 0
  const failedLegacyState = normalizeFailedLegacyState(value.failedLegacyState)
    .filter((item) => item.retainedForVersion >= CURRENT_STATE_MIGRATION_VERSION)
  return {
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : DEFAULT_PLUGIN_DATA.baseUrl,
    secretName: typeof value.secretName === 'string' ? value.secretName : '',
    readingMarkers: Array.from(new Set(markers)),
    listPaneWidth: width === null
      ? null
      : Math.min(MAX_STORED_LIST_PANE_WIDTH, Math.max(MIN_LIST_PANE_WIDTH, width)),
    readingPositions: positions,
    readingAppearance: appearance,
    stateMigrationVersion,
    failedLegacyState,
  }
}

function normalizeFailedLegacyState(raw: unknown): FailedLegacyState[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): FailedLegacyState[] => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    if (value.type !== 'marker' && value.type !== 'position') return []
    if (typeof value.key !== 'string' || value.key.length > 160) return []
    const retainedForVersion = typeof value.retainedForVersion === 'number'
      && Number.isInteger(value.retainedForVersion)
      ? value.retainedForVersion
      : 0
    return [{
      type: value.type,
      key: value.key,
      mode: typeof value.mode === 'string' ? value.mode.slice(0, 64) : undefined,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : undefined,
      retainedForVersion,
    }]
  }).slice(0, 500)
}

export function normalizeReadingPosition(raw: unknown): ReadingPosition | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.key !== 'string' || !READING_MARKER_PATTERN.test(value.key)) return null
  if (typeof value.mode !== 'string' || !READING_MODE_PATTERN.test(value.mode)) return null
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)) return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return null
  return {
    key: value.key as ReadingMarkerKey,
    mode: value.mode as ReadingViewMode,
    progress: Math.min(1, Math.max(0, value.progress)),
    updatedAt: Math.round(value.updatedAt),
  }
}

export function normalizeReadingPositions(raw: unknown): ReadingPosition[] {
  if (!Array.isArray(raw)) return []
  const newestByContext = new Map<string, ReadingPosition>()
  for (const item of raw) {
    const position = normalizeReadingPosition(item)
    if (!position) continue
    const context = `${position.key}|${position.mode}`
    const existing = newestByContext.get(context)
    if (!existing || position.updatedAt >= existing.updatedAt) newestByContext.set(context, position)
  }
  return Array.from(newestByContext.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_READING_POSITIONS)
}

export function normalizeReadingAppearance(raw: unknown): ReadingAppearance {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    fontSize: clampNumber(value.fontSize, READING_APPEARANCE_LIMITS.fontSize, DEFAULT_READING_APPEARANCE.fontSize, 0),
    lineHeight: clampNumber(value.lineHeight, READING_APPEARANCE_LIMITS.lineHeight, DEFAULT_READING_APPEARANCE.lineHeight, 1),
    maxWidth: clampNumber(value.maxWidth, READING_APPEARANCE_LIMITS.maxWidth, DEFAULT_READING_APPEARANCE.maxWidth, 0),
  }
}

function clampNumber(
  raw: unknown,
  limits: { readonly min: number; readonly max: number },
  fallback: number,
  precision: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const factor = 10 ** precision
  return Math.round(Math.min(limits.max, Math.max(limits.min, raw)) * factor) / factor
}
