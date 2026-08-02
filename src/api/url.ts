export function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('OpenRSS 地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenRSS 地址必须使用 HTTP 或 HTTPS')
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
    || url.hostname === '::1'
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('远程 OpenRSS 必须使用 HTTPS；HTTP 仅允许 localhost/127.0.0.1/::1')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OpenRSS 地址不能包含账号、密码、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}
