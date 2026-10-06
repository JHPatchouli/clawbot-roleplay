/**
 * 向量存储：内存余弦检索（单用户规模足够）。
 * 存于集合 vectors：{ id, vector:number[], createdAt, characterId, ownerId, sessionId }
 *
 * 多租户（P7）：search 支持 ownerId 过滤（自己的 + 共享的）。
 * 会话隔离：search 支持 sessionId 过滤——**只排除“明确属于别的会话”的条目**，
 * sessionId 为空/缺省的一律当作全局条目，任何会话都看得到（故意如此：
 * 导入旧数据时 sessionId 会指向一个不存在的会话，若把它当成“别的会话”藏起来，
 * 用户会看到记忆凭空消失）。
 * 注意：向量条目与 memories 条目一一对应（同 id），
 * 归属必须两边一致，否则会出现「记忆看得到但检索不到」。
 */

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function createVectorStore(store) {
  const col = store.collection('vectors')
  return {
    put(id, vector, meta = {}) {
      return col.put({ id, vector, createdAt: Date.now(), ...meta })
    },
    remove(id) {
      col.remove(id)
    },
    get(id) {
      return col.get(id)
    },
    clear() {
      col.clear()
    },
    count(ownerId = undefined) {
      if (ownerId === undefined) return col.list().length
      return col.list().filter((v) => !v.ownerId || v.ownerId === ownerId).length
    },
    /**
     * 余弦检索
     * @param {object} [opts] { k, threshold, characterId, ownerId, sessionId }
     *   ownerId 传 null 表示只看共享条目；不传则不按归属过滤（内部/迁移用）
     *   sessionId 不传 = 不按会话过滤；传了则排除「属于别的会话」的条目
     *   ⚠️ 过滤必须在排序取前 k 之前做（就是这里）：若先取 top-k 再过滤，
     *   当别的会话记忆很多时，前 k 条可能被它们占满，本会话明明有命中却一条都拿不到。
     * @returns {Array<{id, score, characterId}>}
     */
    search(query, { k = 5, threshold = 0, characterId = null, ownerId = undefined, sessionId = null } = {}) {
      const hits = []
      for (const v of col.list()) {
        if (ownerId !== undefined && v.ownerId && v.ownerId !== ownerId) continue
        if (characterId && v.characterId && v.characterId !== characterId) continue
        if (sessionId && v.sessionId && v.sessionId !== sessionId) continue
        const score = cosine(query, v.vector)
        if (score >= threshold) hits.push({ id: v.id, score, characterId: v.characterId || null })
      }
      hits.sort((a, b) => b.score - a.score)
      return hits.slice(0, k)
    }
  }
}
