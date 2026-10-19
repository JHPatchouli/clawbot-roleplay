/**
 * 待发件箱（独立文件，避免与运行中的 JsonStore 互相覆盖）。
 * entries: [{ userId, name, path, at }]
 */
import fs from 'node:fs'
import path from 'node:path'

export function outboxFile(dataDir) {
  return path.join(dataDir, 'outbox.json')
}
export function readOutbox(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(outboxFile(dataDir), 'utf8'))
  } catch (_) {
    return []
  }
}
export function writeOutbox(dataDir, list) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(outboxFile(dataDir), JSON.stringify(list, null, 2))
}
export const OUTBOX_MAX_AGE_MS = 6 * 60 * 60 * 1000
export const OUTBOX_MAX_TRIES = 3

export function pruneOutbox(list, now = Date.now()) {
  const kept = []
  const dropped = []
  for (const item of Array.isArray(list) ? list : []) {
    const age = now - Number(item?.at || now)
    const tries = Number(item?.tries || 0)
    if (age > OUTBOX_MAX_AGE_MS) dropped.push({ ...item, reason: 'expired' })
    else if (tries >= OUTBOX_MAX_TRIES) dropped.push({ ...item, reason: 'too-many-failures' })
    else kept.push(item)
  }
  return { kept, dropped }
}

export function enqueue(dataDir, entry, now = Date.now()) {
  const pruned = pruneOutbox(readOutbox(dataDir), now)
  const duplicate = pruned.kept.some((item) => item.userId === entry.userId && item.path === entry.path && item.name === entry.name)
  if (!duplicate) pruned.kept.push({ ...entry, tries: Number(entry?.tries || 0), at: Number(entry?.at || now) })
  writeOutbox(dataDir, pruned.kept)
  return pruned.kept.length
}
export function takeFor(dataDir, userId, limit = 1) {
  const all = readOutbox(dataDir)
  const max = Math.max(0, Number(limit) || 0)
  const mine = []
  const rest = []
  for (const item of all) {
    if (item.userId === userId && mine.length < max) mine.push(item)
    else rest.push(item)
  }
  if (mine.length) writeOutbox(dataDir, rest)
  return mine
}
