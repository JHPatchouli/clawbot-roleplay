/**
 * 多租户作用域：角色卡 / 世界书 / 记忆按 ownerId 隔离。
 *
 * 归属规则（三态）：
 *   ownerId === userId  → 该用户私有，可改可删
 *   ownerId 为空         → 共享，所有人可见；普通用户不可改删（需先 clone 成自己的）
 *   其他用户的 ownerId    → 对该用户完全不可见
 *
 * 迁移策略（零破坏、无需改写存储）：
 *   P6 及之前的数据没有 ownerId 字段，一律按「共享」解释，
 *   因此升级后原有角色 / 世界书 / 记忆对所有用户仍然可见，
 *   只是「新导入的内容」默认归创建者私有。需要收归私有可用 /char claim。
 *
 * 为什么不做「物理分库分集合」：
 *   JsonStore 的 collections 是单层 {id: obj} 映射，按 id 隔离需要复合键；
 *   而记忆的向量检索、世界书的关键词命中都需要跨条目扫描，
 *   用 ownerId 过滤（而非分桶）能保持检索逻辑不变，改动面最小。
 */

/** 共享条目的 ownerId 取值（沿用「字段不存在」的表示，兼容旧数据） */
export const SHARED = null

export function isShared(obj) {
  return !obj || !obj.ownerId
}

/** 该用户是否可见 */
export function visibleTo(obj, userId) {
  return isShared(obj) || !userId || obj.ownerId === userId
}

/** 该用户是否拥有（可用于改删） */
export function ownedBy(obj, userId) {
  return Boolean(obj) && Boolean(userId) && obj.ownerId === userId
}

/**
 * 带归属的集合视图。
 *
 * 与 store.collection(name) 的差异：
 *  - list() 只返回「自己的 + 共享的」，且自己的排前面
 *  - get(id) 对不可见条目返回 null（防止越权按 id 直取）
 *  - put() 自动打上 ownerId（显式传入可覆盖，用于写入共享条目）
 *  - remove() 默认只能删自己的，共享条目需 force
 */
export function scopedCollection(store, name, userId) {
  const col = store.collection(name)
  return {
    name,
    userId,
    raw: col,

    /** 可见条目：自己拥有的在前，共享的在后 */
    list() {
      return col
        .list()
        .filter((o) => visibleTo(o, userId))
        .map((o) => ({ ...o, shared: isShared(o) }))
        .sort((a, b) => Number(a.shared) - Number(b.shared))
    },

    /** 自己拥有的条目 */
    listOwn() {
      return col.list().filter((o) => ownedBy(o, userId))
    },

    /** 共享条目 */
    listShared() {
      return col.list().filter((o) => isShared(o))
    },

    /** 按序号取（配合 list() 的展示顺序） */
    pick(index) {
      const arr = this.list()
      const i = Number(index)
      return Number.isInteger(i) && i >= 1 && i <= arr.length ? arr[i - 1] : null
    },

    /** 可见才返回，否则 null */
    get(id) {
      const o = col.get(id)
      return o && visibleTo(o, userId) ? { ...o, shared: isShared(o) } : null
    },

    /** 不做可见性检查的原始读取（仅内部迁移/统计用） */
    getRaw(id) {
      return col.get(id)
    },

    /** 写入：默认归属当前用户；传 ownerId: null 写共享条目 */
    put(obj) {
      const next = { ...obj }
      if (!('ownerId' in next)) next.ownerId = userId
      if (next.ownerId === undefined) next.ownerId = userId
      return col.put(next)
    },

    remove(id, { force = false } = {}) {
      const o = col.get(id)
      if (!o) return false
      if (!force && !ownedBy(o, userId)) return false
      col.remove(id)
      return true
    },

    /** 删除当前用户拥有的全部条目（不动共享数据） */
    clearOwn() {
      let n = 0
      for (const o of col.list()) {
        if (ownedBy(o, userId)) {
          col.remove(o.id)
          n++
        }
      }
      return n
    },

    /** 清空整个集合（含共享与其他用户的数据）——仅管理员/离线自检用 */
    clearAll() {
      col.clear()
    }
  }
}

/** 当前角色（每用户一个），键按用户隔离 */
export function currentCharacterKey(userId) {
  return 'currentCharacterId:' + userId
}

/** P6 的全局键，仅用于读取时兼容旧数据 */
export const LEGACY_CURRENT_CHARACTER_KEY = 'currentCharacterId'

/** 归属统计（/dashboard、/status 展示，便于确认迁移结果） */
export function ownershipStats(store, userId, names = ['characters', 'lorebook', 'memories']) {
  const out = {}
  for (const name of names) {
    const all = store.collection(name).list()
    out[name] = {
      total: all.length,
      own: all.filter((o) => ownedBy(o, userId)).length,
      shared: all.filter((o) => isShared(o)).length,
      others: all.filter((o) => o.ownerId && o.ownerId !== userId).length
    }
  }
  return out
}
