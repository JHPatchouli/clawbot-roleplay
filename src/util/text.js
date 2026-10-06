/**
 * 文本工具：按长度上限切分长回复，避免超出微信单条消息限制。
 * 优先在换行处切分，保留段落可读性。
 */
/**
 * 回复分段：按换行拆成多条（角色扮演提示词要求逐行分段），
 * 超长片段再按长度切分，并限制总条数避免刷屏。
 * @returns {string[]} 逐条发送的文本片段
 */
export function splitSegments(text, { maxCharsPerMessage = 1800, segment = true } = {}) {
  const src = String(text ?? '').trim()
  if (!src) return []
  const pieces = segment ? src.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [src]
  const out = []
  for (const p of pieces) out.push(...chunkText(p, maxCharsPerMessage))
  // 过短碎片（如「好。」「一。」）并入上一段，避免刷屏与限流
  const merged = []
  for (const s of out) {
    if (merged.length && s.length < 4) merged[merged.length - 1] += '\n' + s
    else merged.push(s)
  }
  return merged.length ? merged : [src]
}

export function chunkText(text, maxChars = 1800) {
  const src = String(text ?? '')
  if (src.length <= maxChars) return src ? [src] : []
  const chunks = []
  let rest = src
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}
