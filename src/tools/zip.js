/**
 * 最小 ZIP 编/解码器（纯 Node，零依赖）。
 *
 * 为什么要自己写：
 *   ① 容器里**没有 `zip`/`unzip` 命令**（Debian 精简镜像），也不能装；
 *   ② 更不想 fork 系统命令——参数里带着模型给的路径，等于给它一条 shell 注入的口子；
 *   ③ 目标接收方是**手机上的微信**：`.zip` 双端点开就能看，`.tar.gz` 还得装应用。
 *   ZIP 容器本身很简单（本地头 + 中央目录 + EOCD），而 deflate 直接用 `zlib` 的 raw 版本。
 *
 * 只在需要的范围内实现：store(0) 与 deflate(8) 两种方法、无加密、无 zip64
 * （单文件与总大小都远在 4GB 以下；真超了会明确报错，而不是写出一个坏包）。
 *
 * ⚠️ 解码侧是**不可信输入**：`../` 逃逸（zip-slip）、绝对路径、盘符、压缩炸弹
 *   都在这里拦掉，调用方还会再加一层目录校验。
 */
import zlib from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const LIMIT_4G = 0xffffffff

/** CRC-32 表（多项式 0xEDB88320，ZIP 用的就是它） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 毫秒 → DOS 时间/日期（ZIP 用的是 1980 纪元的怪格式） */
function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/** 归档内的路径一律用 `/`，并做基本清理（反斜杠、开头的 ./ 、重复斜杠） */
export function normalizeEntryName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
}

/**
 * 判断归档内的条目名是否安全（解码侧第一道闸门）。
 *
 * ⚠️ 先在**原始名字**上判绝对路径：`normalizeEntryName` 会把开头的 `/` 去掉，
 *   若先归一化再判，「/abs/evil」会被**悄悄改成**相对路径而放行——
 *   对不可信压缩包不该「默默修正」，合法归档里本来就不会有绝对路径（我们自己的
 *   buildZip 用 path.relative 生成，永远相对）。自检就是这个形状抓到的。
 * 拒：空、绝对路径、盘符、任何 `..`/`.` 段、含 NUL、目录条目。
 */
export function isSafeEntryName(name) {
  const raw = String(name || '').replace(/\\/g, '/')
  if (raw.includes('\0')) return { ok: false, reason: '含 NUL' }
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return { ok: false, reason: '绝对路径' }
  const n = normalizeEntryName(raw)
  if (!n) return { ok: false, reason: '空文件名' }
  if (n.endsWith('/')) return { ok: false, reason: '目录条目' }
  if (n.split('/').some((seg) => seg === '..' || seg === '.')) return { ok: false, reason: '含 .. 或 . 段' }
  return { ok: true, name: n }
}

/**
 * 打一个 zip 包。
 * @param {Array<{name:string, data:Buffer, mtime?:number}>} entries
 * @param {object} [opts] { maxEntries, maxTotalBytes }
 * @returns {{buffer:Buffer, entries:number, rawBytes:number, storedBytes:number, method:{deflate:number,store:number}}}
 */
export function buildZip(entries, { maxEntries = 500, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) throw new Error('没有要打包的文件')
  if (list.length > maxEntries) throw new Error(`文件太多（${list.length} 个，上限 ${maxEntries} 个）`)

  const used = new Set()
  const locals = []
  const centrals = []
  let rawBytes = 0
  let storedBytes = 0
  let offset = 0
  const methodCount = { deflate: 0, store: 0 }

  for (const e of list) {
    const safe = isSafeEntryName(e.name)
    if (!safe.ok) throw new Error(`文件名不能用：${e.name}（${safe.reason}）`)
    let name = safe.name
    // 重名：加后缀，别让后一个静默盖掉前一个
    if (used.has(name)) {
      const dot = name.lastIndexOf('.')
      const base = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let i = 2
      while (used.has(`${base}-${i}${ext}`)) i++
      name = `${base}-${i}${ext}`
    }
    used.add(name)

    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
    rawBytes += data.length
    if (rawBytes > maxTotalBytes) throw new Error(`内容太大（超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB），先挑一部分`) 

    // 已压缩过的内容（png/zip/jpg）deflate 往往更大 → 那就用 store，两头都省
    let comp = null
    let method = 0
    try {
      const d = zlib.deflateRawSync(data, { level: 6 })
      if (d.length < data.length) {
        comp = d
        method = 8
      }
    } catch (_) {
      /* 压不动就存原样 */
    }
    const body = comp || data
    methodCount[method === 8 ? 'deflate' : 'store'] += 1
    storedBytes += body.length

    const crc = crc32(data)
    const { time, date } = dosDateTime(e.mtime)
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags：文件名是 UTF-8（中文名不乱码的关键）
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // 本地头偏移
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
    if (offset > LIMIT_4G) throw new Error('打包结果超过 4GB，本实现不支持（zip64）')
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return {
    buffer: Buffer.concat([...locals, centralBuf, eocd]),
    entries: list.length,
    rawBytes,
    storedBytes,
    method: methodCount
  }
}

/** zip 条目名的 UTF-8 标志位（通用位标记的 bit 11） */
export const ZIP_UTF8_FLAG = 0x0800

/**
 * 按条目名原始字节解出文件名。
 *
 * ⚠️ 为什么不能一律按 UTF-8 解：
 *   Windows 的「发送到 → 压缩文件夹」等工具按**本地代码页（简中 = GBK）**写文件名、
 *   **不置 UTF-8 标志位**。一律按 UTF-8 解 → 中文名全变成「ƽ��-01.m4a」这种乱码。
 *   而字节本身是合法的 GBK，只是不是合法 UTF-8 —— 所以判别很简单：
 *     · 有标志位 → 直接 UTF-8
 *     · 没标志位 → 先试 UTF-8；出现替换字符（U+FFFD）说明它不是 UTF-8 → 回退 GBK
 *   （很多工具不置标志位但写的是 UTF-8，所以不能只看标志位就断言是 GBK。）
 */
export function decodeEntryName(buf, utf8Flag = false) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (utf8Flag) return bytes.toString('utf8')
  const asUtf8 = bytes.toString('utf8')
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch (_) {
    return asUtf8 // 环境不带 GBK 表（非 full-icu）时保住原样，至少不扰
  }
}

/**
 * 读一个 zip 包（不可信输入）。返回条目列表（已在内存解压）。
 * 闸门：条目数、总解压体积、条目名安全性、CRC 校验。
 * @returns {{entries:Array<{name:string, data:Buffer, mtime:number, size:number}>}}
 */
export function readZip(buf, { maxEntries = 500, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 22) throw new Error('不是有效的 zip（太短）')
  // EOCD 在末尾，注释最长 65535，所以往回找 64KB 就够
  let eocd = -1
  const from = Math.max(0, b.length - 22 - 0xffff)
  for (let i = b.length - 22; i >= from; i--) {
    if (b.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录）')
  const total = b.readUInt16LE(eocd + 10)
  if (total === 0) return { entries: [] }
  if (total > maxEntries) throw new Error(`压缩包里的文件太多（${total} 个，上限 ${maxEntries} 个）`)
  let p = b.readUInt32LE(eocd + 16)
  const out = []
  let totalOut = 0

  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip 目录损坏（第 ' + (i + 1) + ' 项）')
    const method = b.readUInt16LE(p + 10)
    const dosTime = b.readUInt16LE(p + 12)
    const dosDate = b.readUInt16LE(p + 14)
    const crc = b.readUInt32LE(p + 16)
    const csize = b.readUInt32LE(p + 20)
    const usize = b.readUInt32LE(p + 24)
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const cmtLen = b.readUInt16LE(p + 32)
    const localOff = b.readUInt32LE(p + 42)
    const flags = b.readUInt16LE(p + 8)
    const rawName = b.readUInt8(p + 46 + nameLen - 1) // 只是为了让越界立刻暴露
    const name = normalizeEntryName(decodeEntryName(b.subarray(p + 46, p + 46 + nameLen), (flags & ZIP_UTF8_FLAG) !== 0))
    p += 46 + nameLen + extraLen + cmtLen
    if (rawName === undefined) throw new Error('zip 目录损坏（名字越界）')
    // 目录条目直接跳过（我们自己解包时不建空目录）
    if (name.endsWith('/')) continue

    const safe = isSafeEntryName(name)
    if (!safe.ok) throw new Error(`压缩包里有不安全的路径：${name}（${safe.reason}）`)

    if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('zip 数据损坏：' + name)
    const lNameLen = b.readUInt16LE(localOff + 26)
    const lExtraLen = b.readUInt16LE(localOff + 28)
    // 本地头与中央目录里的名字必须一致：
    // zip-slip 的常见玩法就是靠两个解析器各读一个名字来绕过检查（我们以中央目录为准，
    // 但两边不一致本身就说明这个包不对劲）。
    const localName = normalizeEntryName(decodeEntryName(b.subarray(localOff + 30, localOff + 30 + lNameLen), (flags & ZIP_UTF8_FLAG) !== 0))
    if (localName && localName !== name) {
      throw new Error(`zip 内部不一致（本地头写的是「${localName}」，目录里是「${name}」）`)
    }
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    if (dataStart + csize > b.length) throw new Error('zip 数据越界：' + name)
    const raw = b.subarray(dataStart, dataStart + csize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`不支持的压缩方式（method=${method}）：${name}`)

    if (data.length !== usize) {
      throw new Error(`解压后大小对不上（${data.length}≠${usize}）：${name}`)
    }
    totalOut += data.length
    if (totalOut > maxTotalBytes) throw new Error(`解压后太大（超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB），已中止`)
    if (crc !== 0 && crc32(data) !== crc) throw new Error('校验失败（文件可能损坏）：' + name)

    const year = 1980 + ((dosDate >> 9) & 0x7f)
    const month = ((dosDate >> 5) & 0x0f) - 1
    const day = dosDate & 0x1f
    const hour = (dosTime >> 11) & 0x1f
    const min = (dosTime >> 5) & 0x3f
    const sec = (dosTime & 0x1f) * 2
    out.push({ name, data, size: data.length, mtime: new Date(year, month, day, hour, min, sec).getTime() })
  }
  return { entries: out }
}
