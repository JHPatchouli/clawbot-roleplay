/**
 * 每个用户的临时交互状态（菜单选择 / 多步向导），5 分钟过期。
 * 用 store 的 kv 持久化，进程重启后仍可续。
 */
const TTL = 5 * 60 * 1000
const key = (uid) => `wizard:${uid}`

export function createSessions(store) {
  return {
    get(uid) {
      const s = store.get(key(uid))
      if (!s) return null
      if (Date.now() - (s.at || 0) > TTL) {
        store.remove(key(uid))
        return null
      }
      return s
    },
    set(uid, state) {
      store.set(key(uid), { ...state, at: Date.now() })
    },
    clear(uid) {
      store.remove(key(uid))
    }
  }
}
