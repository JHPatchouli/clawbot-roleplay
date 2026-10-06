/**
 * 对话会话（上下文容器）——每个用户可有多个会话，独立历史，互不污染。
 * 当前会话 id 存 kv；会话元数据存 sessions 集合；历史消息存 chat:<uid>:<sid>。
 */
const COLL = 'sessions'

function curKey(uid) {
  return 'currentSession:' + uid
}
function genId() {
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

export function createChatSessions(store) {
  const col = store.collection(COLL)

  const api = {
    list(uid) {
      return col
        .list()
        .filter((s) => s.userId === uid)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    },
    get(uid, id) {
      const s = col.get(id)
      return s && s.userId === uid ? s : null
    },
    create(uid, name) {
      const n = api.list(uid).length + 1
      const s = {
        id: genId(),
        userId: uid,
        name: (name || '').trim().slice(0, 30) || ('会话 ' + n),
        userName: '', // 会话级称呼覆盖；为空则回退全局
        createdAt: Date.now()
      }
      col.put(s)
      store.set(curKey(uid), s.id)
      return s
    },
    current(uid) {
      const id = store.get(curKey(uid))
      if (id) {
        const s = api.get(uid, id)
        if (s) return s
      }
      return api.create(uid)
    },
    use(uid, id) {
      const s = api.get(uid, id)
      if (!s) return null
      store.set(curKey(uid), id)
      return s
    },
    rename(uid, id, name) {
      const s = api.get(uid, id)
      if (!s) return null
      const next = { ...s, name: String(name || '').trim().slice(0, 30) || s.name }
      col.put(next)
      return next
    },
    setUserName(uid, id, userName) {
      const s = api.get(uid, id)
      if (!s) return null
      const next = { ...s, userName: String(userName || '').trim().slice(0, 20) }
      col.put(next)
      return next
    },
    remove(uid, id) {
      const s = api.get(uid, id)
      if (!s) return null
      col.remove(id)
      if (store.get(curKey(uid)) === id) store.remove(curKey(uid))
      return s
    }
  }
  return api
}
