type CacheEntry<T> = {
  value: T
  weight: number
}


export class MemoryLru<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private totalWeight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, weight: number): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.totalWeight -= previous.weight
      this.entries.delete(key)
    }
    const safeWeight = Math.max(0, weight)
    this.entries.set(key, { value, weight: safeWeight })
    this.totalWeight += safeWeight
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry<T>] | undefined
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.totalWeight -= oldest[1].weight
    }
  }

  clear(): void {
    this.entries.clear()
    this.totalWeight = 0
  }
}


export function jsonWeight(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
