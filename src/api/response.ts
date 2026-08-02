export function nonJsonResponseMessage(
  status: number,
  contentType: string | null,
  body: string,
): string {
  const preview = body.trim().replace(/\s+/g, ' ').slice(0, 80)
  const looksLikeHtml = /^<!doctype\s+html|^<html|^</i.test(preview)
  const typeDetail = contentType ? `，Content-Type: ${contentType}` : ''
  const addressHint = looksLikeHtml
    ? '；当前响应看起来是网页，请检查 OpenRSS 地址是否仍为手机本机地址，或是否误填了普通网页地址'
    : ''
  return `OpenRSS 返回了非 JSON 响应（HTTP ${status}${typeDetail}）${addressHint}`
}
