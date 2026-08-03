import { App, Component, loadMermaid, MarkdownRenderer } from 'obsidian'
import { extractMermaidBlocks, type MermaidBlock } from './mermaid-blocks'


type MermaidRenderResult = string | { svg: string }

type MermaidEngine = {
  render: (id: string, source: string) => MermaidRenderResult | Promise<MermaidRenderResult>
}

const MAX_MERMAID_SOURCE_LENGTH = 100_000
let mermaidRenderSequence = 0


export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
}


export function neutralizeFileLinks(markdown: string): string {
  return markdown
    .replace(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, (_match, label: string) => label)
    .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?(?:#[^\]]*)?\]\]/g, (_match, target: string, alias?: string) => alias || target)
}


export async function renderMarkdown(
  app: App,
  owner: Component,
  container: HTMLElement,
  markdown: string,
): Promise<void> {
  container.empty()
  const safe = neutralizeFileLinks(stripFrontmatter(markdown))
  const prepared = extractMermaidBlocks(
    safe,
    `openrss-mermaid-${Date.now()}-${mermaidRenderSequence += 1}`,
  )
  await MarkdownRenderer.render(app, prepared.markdown, container, '', owner)
  await renderMermaidBlocks(container, prepared.blocks)
  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a.external-link'))) {
    anchor.rel = 'noopener noreferrer'
  }
}


async function renderMermaidBlocks(container: HTMLElement, blocks: MermaidBlock[]): Promise<void> {
  if (!blocks.length) return
  const byToken = new Map(blocks.map((block) => [block.token, block]))
  const placeholders = Array.from(
    container.querySelectorAll<HTMLElement>('pre > code.language-openrss-mermaid-placeholder'),
  )
  let engine: MermaidEngine | null = null
  let loadError: unknown = null

  try {
    const loaded = await loadMermaid() as MermaidEngine | { default?: MermaidEngine }
    engine = 'render' in loaded ? loaded : loaded.default || null
    if (!engine?.render) throw new Error('Mermaid engine is unavailable')
  } catch (error) {
    loadError = error
  }

  for (const placeholder of placeholders) {
    const token = placeholder.textContent?.trim() || ''
    const block = byToken.get(token)
    const pre = placeholder.closest('pre')
    if (!block || !pre) continue

    const wrapper = document.createElement('div')
    wrapper.className = 'openrss-library__mermaid'
    pre.replaceWith(wrapper)
    if (!engine || loadError) {
      renderMermaidError(wrapper, block.source, 'Mermaid 引擎加载失败。')
      continue
    }
    if (!block.source || block.source.length > MAX_MERMAID_SOURCE_LENGTH) {
      renderMermaidError(wrapper, block.source, 'Mermaid 图表为空或内容过长。')
      continue
    }

    try {
      const renderId = `openrssMermaid${Date.now()}x${mermaidRenderSequence += 1}`
      const result = await engine.render(renderId, block.source)
      const svgText = typeof result === 'string' ? result : result.svg
      wrapper.appendChild(sanitizeMermaidSvg(svgText))
    } catch {
      renderMermaidError(wrapper, block.source, 'Mermaid 图表语法无法解析。')
    }
  }
}


function sanitizeMermaidSvg(svgText: string): SVGElement {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') {
    throw new Error('Invalid Mermaid SVG')
  }

  for (const blocked of Array.from(parsed.querySelectorAll(
    'script, iframe, object, embed, image, form, input, button, textarea, select, video, audio, canvas, link, meta, base',
  ))) {
    blocked.remove()
  }
  for (const style of Array.from(parsed.querySelectorAll('style'))) {
    if (hasUnsafeCss(style.textContent || '')) style.remove()
  }
  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
      } else if (name === 'href' || name === 'xlink:href' || name === 'src') {
        if (element.localName === 'a' || !value.startsWith('#')) {
          element.removeAttribute(attribute.name)
        }
      } else if (name === 'style' && hasUnsafeCss(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGElement
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Mermaid 图表')
  svg.removeAttribute('height')
  return svg
}


function hasUnsafeCss(value: string): boolean {
  const withoutLocalReferences = value.replace(/url\(\s*(['"]?)#[^)]+\1\s*\)/gi, '')
  return /@import|expression\s*\(|url\s*\(|javascript:|data:/i.test(withoutLocalReferences)
}


function renderMermaidError(container: HTMLElement, source: string, message: string): void {
  const warning = document.createElement('div')
  warning.className = 'openrss-library__mermaid-error'
  warning.textContent = message
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = source
  pre.appendChild(code)
  container.append(warning, pre)
}
