/**
 * 角色扮演 · 当前角色
 *
 * 多租户（P7）：当前角色按 userId 隔离，键为 currentCharacterId:<userId>。
 * 兼容旧数据：读不到自己的键时回退到 P6 的全局键，
 * 保证升级后原用户仍然继承升级前选中的角色（不写回，只读回退）。
 */
import { currentCharacterKey, scopedCollection, LEGACY_CURRENT_CHARACTER_KEY } from '../storage/scope.js'

export function getCurrentCharacterId(store, userId) {
  const own = userId ? store.get(currentCharacterKey(userId)) : null
  if (own) return own
  return store.get(LEGACY_CURRENT_CHARACTER_KEY, null)
}

export function setCurrentCharacterId(store, userId, id) {
  const key = userId ? currentCharacterKey(userId) : LEGACY_CURRENT_CHARACTER_KEY
  if (id) store.set(key, id)
  else store.remove(key)
}

/** 当前角色（可见性检查：私有或共享，否则视为未选择） */
export function getCurrentCharacter(store, userId) {
  const id = getCurrentCharacterId(store, userId)
  if (!id) return null
  return scopedCollection(store, 'characters', userId).get(id)
}
