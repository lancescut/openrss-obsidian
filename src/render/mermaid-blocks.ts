export type MermaidBlock = {
  token: string
  source: string
}

export type PreparedMermaidMarkdown = {
  markdown: string
  blocks: MermaidBlock[]
}


export function extractMermaidBlocks(
  markdown: string,
  tokenPrefix: string,
): PreparedMermaidMarkdown {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  const blocks: MermaidBlock[] = []

  for (let index = 0; index < lines.length;) {
    const opening = lines[index]?.match(/^( {0,3})((?:`{3,})|(?:~{3,}))[ \t]*mermaid(?:[ \t]+.*)?$/i)
    if (!opening) {
      output.push(lines[index] || '')
      index += 1
      continue
    }

    const fence = opening[2]
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    let closingIndex = index + 1
    while (closingIndex < lines.length && !closing.test(lines[closingIndex] || '')) {
      closingIndex += 1
    }
    if (closingIndex >= lines.length) {
      output.push(lines[index] || '')
      index += 1
      continue
    }

    const token = `${tokenPrefix}-${blocks.length}`
    blocks.push({
      token,
      source: lines.slice(index + 1, closingIndex).join('\n').trim(),
    })
    output.push('```openrss-mermaid-placeholder', token, '```')
    index = closingIndex + 1
  }

  return { markdown: output.join(newline), blocks }
}
