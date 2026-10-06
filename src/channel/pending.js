/**
 * 待发文本队列：**发不出去的内容不许丢**，落到磁盘，等限流恢复后自动补发。
 *
 * 为什么必须落盘：
 *   微信侧限流触发后，一条回复能「全军覆没」——分段发失败 → 合并重试也失败。
 *   旧做法是直接 throw「发送失败」，于是**这段内容就从世界上消失了**：
 *   用户等了半天，什么都没收到，日志里只留一行 WARN。
 *   落盘的意义在于：进程重启、限流持续一小时，内容都还在队列里等。
 *
 * 为什么用独立文件（data/pending-replies.json）而不是写进 store.json：
 *   JsonStore 是「整文件原子写 + 内存常驻」，外部进程写它会被运行中的实例覆盖
 *   （outbox.json 的注释里记着这条）。这里是同一进程内写，但仍然分开存，
 *   免得队列的读写把整份 store 反复落盘。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 队列文件路径 */
export function pendingFile(dataDir) {
  return path.join(dataDir, 'pending-replies.json')
}

/** 读队列（文件损坏/不存在都当空队列，不让它拖垮发送路径） */
export function readPending(dataDir) {
  if (!dataDir) return []
  try {
    const v = JSON.parse(fs.readFileSync(pendingFile(dataDir), 'utf8'))
    return Array.isArray(v) ? v.filter((x) => x && x.text) : []
  } catch (_) {
    return []
  }
}

/** 覆盖写队列（同步写：内容是用户要收到的消息，不能因为进程退出就丢） */
export function writePending(dataDir, list) {
  if (!dataDir) return
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(pendingFile(dataDir), JSON.stringify(list, null, 2))
  } catch (_) {
    // 写不进去也不能让发送路径炸掉
  }
}

/**
 * 入队。返回 { queued, dropped }。
 *
 * 上限（默认 500 条）：宁可丢最旧的并**大声说出来**，也不让磁盘无限涨。
 * 真到这一步说明账号被长时间压制，日志里的 WARN 是唯一的线索。
 */
export function enqueuePending(dataDir, entries, { cap = 500 } = {}) {
  const list = readPending(dataDir)
  const at = Date.now()
  for (const e of entries || []) {
    if (!e || !e.text) continue
    list.push({ userId: e.userId, contextToken: e.contextToken || '', text: String(e.text), at })
  }
  let dropped = 0
  while (list.length > cap) {
    list.shift()
    dropped++
  }
  writePending(dataDir, list)
  return { queued: list.length, dropped }
}

/** 队列概况（给 /status 用） */
export function pendingStats(dataDir) {
  const list = readPending(dataDir)
  return {
    count: list.length,
    oldestAt: list.length ? list[0].at : null,
    chars: list.reduce((n, x) => n + String(x.text || '').length, 0)
  }
}
