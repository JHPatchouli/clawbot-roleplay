/**
 * 角色扮演 · 世界书触发（关键词 / 常驻）
 *
 * 多租户（P7）：只读取「该用户私有的 + 共享的」条目，
 * 其他用户的世界书不参与命中（避免串戏）。
 */
import { scopedCollection } from '../storage/scope.js'

export function getTriggeredLore(store, contextText, userId = null) {
  const entries = scopedCollection(store, 'lorebook', userId).list()
  if (!entries.length) return null
  const text = contextText || ''
  const hit = entries.filter((e) => e.active || (e.keys || []).some((k) => k && text.includes(k)))
  if (!hit.length) return null
  hit.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.priority || 0) - (a.priority || 0))
  const body = hit.map((e) => (e.title ? `【${e.title}】\n${e.content}` : e.content)).join('\n\n')
  return `世界设定：\n${body}`
}
