/**
 * 图片载体：把 JSON 存进 PNG 的私有数据块（ancillary chunk），
 * 文件结构完全合法、可正常显示，解码器会跳过该块。
 *
 * 块类型 'chai'（首字母小写 = ancillary，解码器应忽略）：
 *   data = <<<APP_JSON_BEGIN>>>{json}<<<APP_JSON_END>>>
 * 同时兼容旧式「IEND 后追加」的提取方式。
 */
import zlib from 'node:zlib'

export const BEGIN = '<<<APP_JSON_BEGIN>>>'
export const END = '<<<APP_JSON_END>>>'
// PNG 块类型：第1位小写=ancillary(可忽略)，第2位小写=private，
// 第3位必须大写(reserved bit=0)，第4位小写=safe-to-copy。'chai' 第3位小写是非法 PNG！
const CHUNK_TYPE = 'chAi'

const crcTable = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makeChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** 生成一张简洁的 PNG（浅色底 + 四角标记），可选把载荷写入私有块 */
export function makeCarrierPng(w = 240, h = 240, payloadText = null) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3
      const corner = (x < 40 && y < 40) || (x >= w - 40 && y >= h - 40)
      raw[p] = corner ? 60 : 236
      raw[p + 1] = corner ? 120 : 240
      raw[p + 2] = corner ? 220 : 246
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = [sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', zlib.deflateSync(raw))]
  if (payloadText != null) {
    const data = Buffer.from(BEGIN + payloadText + END, 'utf8')
    chunks.push(makeChunk(CHUNK_TYPE, data))
  }
  chunks.push(makeChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

/** 兼容旧法：把文本追加到 PNG 之后 */
export function packText(pngBuffer, text) {
  return Buffer.concat([pngBuffer, Buffer.from('\n' + BEGIN + '\n' + text + '\n' + END + '\n', 'utf8')])
}

/** 解析 PNG 私有块，取出载荷 */
function extractFromChunks(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  let off = 8
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off)
    const type = buffer.subarray(off + 4, off + 8).toString('latin1')
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > buffer.length) break
    if (type === CHUNK_TYPE) {
      const text = buffer.subarray(dataStart, dataEnd).toString('utf8')
      const m = text.match(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*)' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return m ? m[1].trim() : text.trim()
    }
    if (type === 'IEND') break
    off = dataEnd + 4
  }
  return null
}

/** 从图片字节中提取载荷（优先私有块，其次 IEND 后追加） */
export function extractText(buffer) {
  const fromChunk = extractFromChunks(buffer)
  if (fromChunk != null) return fromChunk
  const s = buffer.toString('utf8')
  const i = s.indexOf(BEGIN)
  if (i < 0) return null
  const j = s.indexOf(END, i)
  if (j < 0) return null
  return s.slice(i + BEGIN.length, j).trim()
}
