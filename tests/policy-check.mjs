import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'src')

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const source = walk(src)
  .filter((path) => extname(path) === '.ts')
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const styles = readFileSync(resolve(root, 'styles.css'), 'utf8')

const forbidden = [
  ['Vault file API', /\bapp\.vault\b|\bthis\.app\.vault\b|Vault\.create|Vault\.modify/],
  ['Vault adapter', /\.adapter\b/],
  ['localStorage', /\blocalStorage\b/],
  ['IndexedDB', /\bindexedDB\b|\bIDBDatabase\b/],
  ['Node file system', /from\s+['"](?:node:)?fs['"]|require\(['"]fs['"]\)/],
  ['telemetry', /\btelemetry\b|\banalytics\b|\bsentry\b/i],
]
for (const [name, pattern] of forbidden) {
  if (pattern.test(source)) throw new Error(`Policy violation: ${name}`)
}

const main = readFileSync(resolve(root, 'src', 'main.ts'), 'utf8')
if (!/const snapshot: StoredPluginData = \{\s*baseUrl:[\s\S]*secretName:[\s\S]*readingMarkers:[\s\S]*listPaneWidth:[\s\S]*readingPositions:[\s\S]*readingAppearance:/.test(main)) {
  throw new Error('Plugin data whitelist is missing')
}
for (const contentKey of ['body_md', 'translated_text', 'note_ids', 'assets']) {
  if (main.includes(contentKey)) throw new Error(`main.ts may not persist ${contentKey}`)
}

const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
if (manifest.minAppVersion !== '1.11.4' || manifest.isDesktopOnly !== false) {
  throw new Error('Manifest compatibility contract failed')
}
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const versionsManifest = JSON.parse(readFileSync(resolve(root, 'versions.json'), 'utf8'))
if (manifest.version !== packageManifest.version || versionsManifest[manifest.version] !== manifest.minAppVersion) {
  throw new Error('Release version contract failed')
}
for (const required of ['main.js', 'manifest.json', 'styles.css']) {
  if (!statSync(resolve(root, required)).isFile()) throw new Error(`Missing release file: ${required}`)
}
if (existsSync(resolve(root, 'data.json'))) throw new Error('Public repository must not contain plugin data.json')

const publicText = [
  source,
  readFileSync(resolve(root, 'README.md'), 'utf8'),
  readFileSync(resolve(root, 'manifest.json'), 'utf8'),
  readFileSync(resolve(root, 'versions.json'), 'utf8'),
  readFileSync(resolve(root, 'package.json'), 'utf8'),
  readFileSync(resolve(root, 'esbuild.config.mjs'), 'utf8'),
].join('\n')
const privatePatterns = [
  ['actual OpenRSS token', /\bors_ob_[A-Za-z0-9_-]{8,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal Tailscale host', /desktop-g\d+|tailb43722|100\.71\.69\.6/i],
  ['private workspace path', /E:\\github\\openrss/i],
]
for (const [name, pattern] of privatePatterns) {
  if (pattern.test(publicText)) throw new Error(`Public repository contains ${name}`)
}

const mainJs = readFileSync(resolve(root, 'main.js'), 'utf8')
if (!mainJs.includes('openrss-library-view')) throw new Error('Built plugin does not contain its custom view')
if (!source.includes('URL.revokeObjectURL') || !source.includes('this.cache.clear()')) {
  throw new Error('View cleanup contract is missing')
}

async function importTypeScript(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

const { normalizeBaseUrl } = await importTypeScript(resolve(src, 'api', 'url.ts'))
if (normalizeBaseUrl('http://127.0.0.1:8787/') !== 'http://127.0.0.1:8787') {
  throw new Error('Loopback URL normalization failed')
}

const { nonJsonResponseMessage } = await importTypeScript(resolve(src, 'api', 'response.ts'))
const htmlResponseMessage = nonJsonResponseMessage(200, 'text/html; charset=utf-8', '<!doctype html>')
if (!htmlResponseMessage.includes('非 JSON') || !htmlResponseMessage.includes('当前响应看起来是网页')) {
  throw new Error('Non-JSON response guidance failed')
}

const { nextMobileDrawerOpen } = await importTypeScript(resolve(src, 'mobile-drawer.ts'))
if (
  nextMobileDrawerOpen(true, 'toggle') !== false
  || nextMobileDrawerOpen(false, 'toggle') !== true
  || nextMobileDrawerOpen(false, 'open') !== true
  || nextMobileDrawerOpen(true, 'close') !== false
  || nextMobileDrawerOpen(true, 'select') !== false
) {
  throw new Error('Mobile drawer state transitions failed')
}
if (
  (source.match(/setMobileListState\('select'\)/g) || []).length < 2
  || !source.includes("this.mobileListBackdropEl.setAttribute('aria-hidden', String(!this.mobileListOpen))")
  || !styles.includes('.openrss-library__body.is-mobile-list-open .openrss-library__list-pane')
  || !styles.includes('.openrss-library__mobile-list-backdrop')
  || styles.includes('grid-template-rows: minmax(180px, 32%)')
) {
  throw new Error('Mobile drawer layout contract failed')
}
if (
  (source.match(/subscription_id: params\.subscriptionId/g) || []).length < 2
  || !source.includes('translationSubscriptionFacets')
  || !source.includes("facets: { subscriptions: SubscriptionFacet[] }")
) {
  throw new Error('Translation subscription filter contract failed')
}
const { extractMermaidBlocks } = await importTypeScript(resolve(src, 'render', 'mermaid-blocks.ts'))
const preparedMermaid = extractMermaidBlocks([
  '# Diagram',
  '```mermaid',
  'flowchart TD',
  'A --> B',
  '```',
  '~~~MERMAID optional-title',
  'graph LR',
  'X --> Y',
  '~~~~',
  '```js',
  'console.log("keep")',
  '```',
].join('\n'), 'test-mermaid')
if (
  preparedMermaid.blocks.length !== 2
  || preparedMermaid.blocks[0]?.source !== 'flowchart TD\nA --> B'
  || preparedMermaid.blocks[1]?.source !== 'graph LR\nX --> Y'
  || preparedMermaid.markdown.includes('```mermaid')
  || !preparedMermaid.markdown.includes('```js\nconsole.log("keep")\n```')
  || !source.includes('loadMermaid')
  || !source.includes("'script, iframe, object, embed, image, form, input, button")
  || !styles.includes('.openrss-library__mermaid svg')
) {
  throw new Error('Safe Mermaid rendering contract failed')
}
if (normalizeBaseUrl('https://rss.example.com/') !== 'https://rss.example.com') {
  throw new Error('HTTPS URL normalization failed')
}
for (const unsafe of ['http://rss.example.com', 'https://user:pass@rss.example.com', 'file:///tmp/openrss']) {
  let rejected = false
  try { normalizeBaseUrl(unsafe) } catch { rejected = true }
  if (!rejected) throw new Error(`Unsafe URL was accepted: ${unsafe}`)
}

const { MemoryLru } = await importTypeScript(resolve(src, 'memory-cache.ts'))
const cache = new MemoryLru(2, 10)
cache.set('a', 'A', 4)
cache.set('b', 'B', 4)
if (cache.get('a') !== 'A') throw new Error('LRU read failed')
cache.set('c', 'C', 4)
if (cache.get('b') !== undefined || cache.get('a') !== 'A' || cache.get('c') !== 'C') {
  throw new Error('LRU entry eviction failed')
}
cache.set('large', 'L', 9)
if (cache.get('a') !== undefined || cache.get('c') !== undefined || cache.get('large') !== 'L') {
  throw new Error('LRU weight eviction failed')
}
cache.clear()
if (cache.get('large') !== undefined) throw new Error('LRU clear failed')

const {
  LongPressGesture,
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_TOLERANCE,
} = await importTypeScript(resolve(src, 'long-press.ts'))
let scheduled = null
let nextTimerId = 1
const cancelledTimers = []
const longPress = new LongPressGesture(
  (callback, delayMs) => {
    scheduled = { callback, delayMs, timerId: nextTimerId++ }
    return scheduled.timerId
  },
  (timerId) => cancelledTimers.push(timerId),
)
let longPressTriggers = 0
longPress.start(7, 100, 200, () => { longPressTriggers += 1 })
if (scheduled?.delayMs !== LONG_PRESS_MS) throw new Error('Long-press delay contract failed')
longPress.move(7, 100 + LONG_PRESS_MOVE_TOLERANCE, 200)
scheduled.callback()
if (longPressTriggers !== 1) throw new Error('Long press did not trigger at the movement boundary')

longPress.start(8, 0, 0, () => { longPressTriggers += 1 })
const movedTimer = scheduled
longPress.move(8, LONG_PRESS_MOVE_TOLERANCE + 0.1, 0)
movedTimer.callback()
if (longPressTriggers !== 1 || !cancelledTimers.includes(movedTimer.timerId)) {
  throw new Error('Movement did not cancel long press')
}

longPress.start(9, 0, 0, () => { longPressTriggers += 1 })
const releasedTimer = scheduled
if (longPress.end(10) !== false) throw new Error('Unrelated pointer ended long press')
if (longPress.end(9) !== true) throw new Error('Active pointer was not ended')
releasedTimer.callback()
if (longPressTriggers !== 1 || !cancelledTimers.includes(releasedTimer.timerId)) {
  throw new Error('Pointer release did not cancel long press')
}

const {
  DEFAULT_READING_APPEARANCE,
  normalizeStoredPluginData,
  noteMarkerKey,
  translationMarkerKey,
} = await importTypeScript(resolve(src, 'plugin-state.ts'))
const normalized = normalizeStoredPluginData({
  baseUrl: 'https://rss.example.com',
  secretName: 'mobile-secret',
  readingMarkers: ['note:42', 'note:42', 'translation:reader:7', 'invalid', 'note:0'],
  listPaneWidth: 2,
  readingPositions: [
    { key: 'note:42', mode: 'note', progress: 0.4, updatedAt: 100 },
    { key: 'note:42', mode: 'note', progress: 0.6, updatedAt: 200 },
    { key: 'translation:reader:7', mode: 'translation-segments', progress: 1.5, updatedAt: 150 },
    { key: 'note:42', mode: 'invalid', progress: 0.2, updatedAt: 300 },
    { key: 'note:42', mode: 'reader', progress: 'secret text', updatedAt: 300 },
  ],
  readingAppearance: { fontSize: 99, lineHeight: 1.83, maxWidth: 100 },
  body_md: 'must be ignored',
})
if (JSON.stringify(normalized) !== JSON.stringify({
  baseUrl: 'https://rss.example.com',
  secretName: 'mobile-secret',
  readingMarkers: ['note:42', 'translation:reader:7'],
  listPaneWidth: 28,
  readingPositions: [
    { key: 'note:42', mode: 'note', progress: 0.6, updatedAt: 200 },
    { key: 'translation:reader:7', mode: 'translation-segments', progress: 1, updatedAt: 150 },
  ],
  readingAppearance: { fontSize: 26, lineHeight: 1.8, maxWidth: 560 },
})) {
  throw new Error(`Plugin state normalization failed: ${JSON.stringify(normalized)}`)
}
if (noteMarkerKey(42) !== 'note:42' || translationMarkerKey('summary', 9) !== 'translation:summary:9') {
  throw new Error('Reading marker key generation failed')
}

const cappedPositions = normalizeStoredPluginData({
  readingPositions: Array.from({ length: 520 }, (_, index) => ({
    key: `note:${index + 1}`,
    mode: 'note',
    progress: index / 520,
    updatedAt: index,
  })),
}).readingPositions
if (cappedPositions.length !== 500 || cappedPositions[0]?.key !== 'note:520' || cappedPositions.at(-1)?.key !== 'note:21') {
  throw new Error('Reading-position retention limit failed')
}
if (JSON.stringify(normalizeStoredPluginData({}).readingAppearance) !== JSON.stringify(DEFAULT_READING_APPEARANCE)) {
  throw new Error('Default reading appearance failed')
}

const {
  normalizedReadingProgress,
  readingProgressPercent,
  scrollTopForProgress,
} = await importTypeScript(resolve(src, 'reading-progress.ts'))
if (normalizedReadingProgress(250, 1500, 500) !== 0.25) throw new Error('Reading progress calculation failed')
if (normalizedReadingProgress(0, 400, 500) !== 1) throw new Error('Short-content progress failed')
if (scrollTopForProgress(0.4, 1500, 500) !== 400) throw new Error('Reading position restore failed')
if (readingProgressPercent(0.456) !== 46) throw new Error('Reading percentage rounding failed')

console.log('OK — release is installable; local state is limited to connection, layout, appearance, marker and reading-position metadata')
