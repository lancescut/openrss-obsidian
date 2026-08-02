import { App, Component, MarkdownRenderer } from 'obsidian'


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
  await MarkdownRenderer.render(app, safe, container, '', owner)
  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a.external-link'))) {
    anchor.rel = 'noopener noreferrer'
  }
}
