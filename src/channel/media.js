/**
 * ClawBot 媒体处理：CDN 下载 + AES-128-ECB 解密。
 *
 * 入站媒体引用字段（见协议 media.md §5）：
 *   { full_url, encrypt_query_param, aes_key(Base64), encrypt_type }
 * 图片/视频消息还可能在 item 层（image_item.aeskey / video_item.aeskey）带十六进制 key，存在时优先。
 *
 * 安全：限制大小、不透出 URL/key 到日志、按内容识别 MIME。
 */
import crypto from 'node:crypto'

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024 // 15MB
const TIMEOUT_MS = 25000 // 下载含读取响应体的整体超时

/**
 * 解析入站媒体的 AES key，兼容三种约定：
 *   1. item 层的 hex 字符串（image_item.aeskey / video_item.aeskey）
 *   2. media.aes_key = 原始 16 字节 key 的 base64
 *   3. media.aes_key = 「hex 字符串的 base64」（出站协议就是这种，入站个别类型也会出）
 * 这三种必须都认，否则会得到「媒体缺少有效 AES key」（P7 实际运行中出现过）。
 */
export function resolveKey(media, imageAesKeyHex) {
  if (imageAesKeyHex) {
    const k = Buffer.from(String(imageAesKeyHex), 'hex')
    if (k.length === 16) return k
  }
  if (media?.aes_key) {
    const k = Buffer.from(String(media.aes_key), 'base64')
    if (k.length === 16) return k
  }
  const k2 = Buffer.from(String(media?.aes_key || ''), 'hex')
  if (k2.length === 16) return k2
  // 兼容：aes_key 可能是「hex 字符串的 base64」（出站协议就是这一种，入站个别类型亦同），
  // 此时 base64 解出 32 字节的 ASCII hex，需要再转一次
  if (media?.aes_key) {
    const ascii = Buffer.from(String(media.aes_key), 'base64').toString('latin1')
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
  }
  return null
}

/** AES-128-ECB + PKCS#7 加密（上传用） */
export function encryptEcb(plainBuf, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plainBuf), cipher.final()])
}

/** 生成上传所需元数据（随机 filekey 与 AES key） */
export function buildUploadMeta(plainBuf) {
  const key = crypto.randomBytes(16)
  const cipher = encryptEcb(plainBuf, key)
  const md5 = crypto.createHash('md5').update(plainBuf).digest('hex')
  return {
    key,
    cipher,
    rawsize: plainBuf.length,
    filesize: cipher.length,
    rawfilemd5: md5,
    filekey: crypto.randomBytes(16).toString('hex'),
    aeskeyHex: key.toString('hex'),
    aesKeyBase64: key.toString('base64')
  }
}

function decryptEcb(cipherBuf, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(cipherBuf), decipher.final()])
}

/** 按文件头识别 MIME（不依赖扩展名） */
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  // RIFF 容器需要看偏移 8 的子类型，否则 AVI 会被误判成 webp
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12) {
    const sub = buf.subarray(8, 12).toString('latin1')
    if (sub === 'WEBP') return 'image/webp'
    if (sub === 'AVI ') return 'video/x-msvideo'
  }
  // 视频：ISO BMFF（mp4/mov）第 4~8 字节固定为 'ftyp'；WebM/Matroska 为 0x1A45DFA3
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4'
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm'
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'
  if (buf[0] === 0x7b || buf[0] === 0x5b) return 'application/json'
  return 'application/octet-stream'
}

/**
 * 下载并解密入站媒体。
 * @param {object} media  media 引用对象
 * @param {object} [opts] { imageAesKeyHex, maxBytes, logger }
 * @returns {Promise<{buffer:Buffer, mime:string, bytes:number, host:string}>}
 */
export async function downloadMedia(media, { imageAesKeyHex, maxBytes = DEFAULT_MAX_BYTES, logger } = {}) {
  const url = media?.full_url
  if (!url) {
    // 缺少 full_url 时无法可靠构造下载地址
    throw new Error('媒体缺少 full_url，无法下载')
  }
  let host = ''
  try {
    host = new URL(url).host
  } catch (_) {
    throw new Error('媒体下载 URL 非法')
  }

  const key = resolveKey(media, imageAesKeyHex)
  if (!key) throw new Error('媒体缺少有效 AES key')

  // ⚠️ 超时必须覆盖「建连 + 读取响应体」全过程：AbortController 在信号
  // 生效期间会中断 fetch 与后续的 arrayBuffer 读取。切勿在 fetch 返回后立即清除。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let cipherBuf
  try {
    logger?.debug(`媒体下载开始 host=${host}`)
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`媒体下载 HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes + 64) throw new Error(`媒体超过大小限制（${len} 字节）`)
    cipherBuf = Buffer.from(await res.arrayBuffer())
    if (cipherBuf.length > maxBytes + 64) throw new Error('媒体超过大小限制')
    logger?.debug(`媒体下载完成 host=${host} 密文=${cipherBuf.length}B`)
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('媒体下载超时')
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    clearTimeout(timer)
  }

  let plain
  try {
    plain = decryptEcb(cipherBuf, key)
  } catch (_) {
    throw new Error('媒体解密失败（AES key 可能不正确）')
  }
  if (plain.length > maxBytes) throw new Error('解密后媒体超过大小限制')
  const mime = sniffMime(plain)
  logger?.debug(`媒体下载成功 host=${host} bytes=${plain.length} mime=${mime}`)
  return { buffer: plain, mime, bytes: plain.length, host }
}

/** 转成模型可直接消费的 data URL（用于视觉模型） */
export function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`
}
