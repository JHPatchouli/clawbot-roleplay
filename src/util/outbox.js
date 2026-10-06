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
export function enqueue(dataDir, entry) {
  const list = readOutbox(dataDir)
  list.push({ ...entry, at: Date.now() })
  writeOutbox(dataDir, list)
  return list.length
}
export function takeFor(dataDir, userId) {
  const all = readOutbox(dataDir)
  const mine = all.filter((e) => e.userId === userId)
  if (mine.length) writeOutbox(dataDir, all.filter((e) => e.userId !== userId))
  return mine
}
