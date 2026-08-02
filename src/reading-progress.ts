export function normalizedReadingProgress(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximum = Math.max(0, scrollHeight - clientHeight)
  if (maximum === 0) return 1
  return Math.min(1, Math.max(0, scrollTop / maximum))
}

export function scrollTopForProgress(
  progress: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximum = Math.max(0, scrollHeight - clientHeight)
  return Math.min(1, Math.max(0, progress)) * maximum
}

export function readingProgressPercent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}
