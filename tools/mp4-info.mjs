/**
 * 极简 MP4 信息探针（零依赖、不需要 ffprobe）。
 *
 *   node tools/mp4-info.mjs <文件> [...]
 *
 * 只解析 MP4 的盒子结构（box），取视频轨的宽高与时长，据此算码率。
 * 用途：判断「微信把视频压缩了」到底是**降分辨率**（有损、不可逆），
 * 还是仅仅重新封装/轻微重编码（体积变化很小）。
 */
import fs from 'node:fs'

/** 遍历一段字节区间内的所有 box */
function* walk(buf, start, end) {
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('latin1')
    let header = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = Number(buf.readBigUInt64BE(off + 8))
      header = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < header || off + size > end || !/^[\w\- ]{4}$/.test(type)) return
    yield { type, dataStart: off + header, end: off + size, size }
    off += size
  }
}

function find(buf, parent, wanted) {
  for (const b of walk(buf, parent.dataStart, parent.end)) if (b.type === wanted) return b
  return null
}

const VIDEO_FORMATS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01'])

/** 在 stsd 里找视频采样描述，返回 { format, width, height } */
function readStsd(buf, stsd) {
  let off = stsd.dataStart + 8 // version/flags(4) + entry_count(4)
  const entryCount = buf.readUInt32BE(stsd.dataStart + 4)
  for (let i = 0; i < entryCount && off + 8 <= stsd.end; i++) {
    const size = buf.readUInt32BE(off)
    const format = buf.subarray(off + 4, off + 8).toString('latin1')
    if (size < 8 || off + size > stsd.end) break
    if (VIDEO_FORMATS.has(format)) {
      // VisualSampleEntry：宽高固定在条目内偏移 32 / 34
      return { format, width: buf.readUInt16BE(off + 32), height: buf.readUInt16BE(off + 34) }
    }
    off += size
  }
  return null
}

function probe(file) {
  const buf = fs.readFileSync(file)
  const out = { file, bytes: buf.length }
  const moov = find(buf, { dataStart: 0, end: buf.length }, 'moov')
  if (!moov) return { ...out, error: '找不到 moov（不是 MP4 或已损坏）' }

  const mvhd = find(buf, moov, 'mvhd')
  if (mvhd) {
    const version = buf[mvhd.dataStart]
    const timescale = version === 1 ? buf.readUInt32BE(mvhd.dataStart + 20) : buf.readUInt32BE(mvhd.dataStart + 12)
    const duration = version === 1 ? Number(buf.readBigUInt64BE(mvhd.dataStart + 24)) : buf.readUInt32BE(mvhd.dataStart + 16)
    if (timescale) out.durationSec = +(duration / timescale).toFixed(3)
  }

  for (const trak of walk(buf, moov.dataStart, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = find(buf, trak, 'mdia')
    if (!mdia) continue
    const hdlr = find(buf, mdia, 'hdlr')
    const handler = hdlr ? buf.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12).toString('latin1') : ''
    const stbl = find(buf, find(buf, mdia, 'minf') || { dataStart: 0, end: 0 }, 'stbl')
    const stsd = stbl ? find(buf, stbl, 'stsd') : null
    if (!stsd) continue
    const entry = readStsd(buf, stsd)
    if (!entry) continue
    if (handler === 'vide') Object.assign(out, entry)
    else if (handler === 'soun') out.audioFormat = entry.format
  }

  if (out.durationSec) out.kbps = Math.round((out.bytes * 8) / out.durationSec / 1000)
  return out
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node tools/mp4-info.mjs <文件> [...]')
  process.exit(1)
}
for (const f of files) {
  const r = probe(f)
  if (r.error) {
    console.log(`${r.file}\n  ✘ ${r.error}（${r.bytes}B）`)
    continue
  }
  console.log(
    `${r.file}\n` +
      `  ${r.width}x${r.height} ${r.format} · ${r.durationSec}s · ${r.bytes}B · ${r.kbps}kbps` +
      (r.audioFormat ? ` · 音频 ${r.audioFormat}` : ' · 无音频轨')
  )
}
