import type { OpenRssClient } from '../api/client'
import type { NoteAsset } from '../api/types'


export class NoteAssetSession {
  private readonly objectUrls = new Map<string, string>()

  async hydrate(
    client: OpenRssClient,
    noteId: number,
    markdown: string,
    assets: NoteAsset[],
  ): Promise<string> {
    let output = markdown
    const referenced = assets.filter((asset) => this.isReferenced(output, asset))
    const loaded = await Promise.all(
      referenced.map(async (asset) => {
        const response = await client.asset(noteId, asset.filename)
        const objectUrl = URL.createObjectURL(
          new Blob([response.bytes], { type: response.contentType || asset.mime }),
        )
        this.objectUrls.set(asset.filename, objectUrl)
        return { asset, objectUrl }
      }),
    )
    for (const { asset, objectUrl } of loaded) {
      for (const candidate of this.candidates(asset)) {
        output = output.split(candidate).join(objectUrl)
      }
    }
    return output
  }

  clear(): void {
    for (const objectUrl of this.objectUrls.values()) {
      URL.revokeObjectURL(objectUrl)
    }
    this.objectUrls.clear()
  }

  private candidates(asset: NoteAsset): string[] {
    return Array.from(new Set([
      asset.markdown_path,
      `./assets/${asset.filename}`,
      `assets/${asset.filename}`,
    ].filter(Boolean)))
  }

  private isReferenced(markdown: string, asset: NoteAsset): boolean {
    return this.candidates(asset).some((candidate) => markdown.includes(candidate))
  }
}
