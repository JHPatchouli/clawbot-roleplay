/**
 * 混合检索：BM25 稀疏检索 + RRF 融合。
 *
 * 为什么要它：
 *   同类框架 的向量库是 FAISS（稠密）+ SQLite FTS5/BM25（稀疏）**混合检索**。
 *   纯稠密向量对「专有名词/约定」不敏感——「靠窗的位置」「Rainbow Cafe」
 *   这类词用关键词命中往往比向量更稳，而向量又擅长「换个说法也能想起来」。
 *   两者融合就是各取所长。
 *
 * 为什么用 RRF（Reciprocal Rank Fusion）而不是加权求和：
 *   两路分数的量纲完全不同（余弦 0~1、BM25 无上界），直接加权要不停调参；
 *   RRF 只用**名次**：`Σ 1/(k + rank)`，k 默认 60。零调参、对量纲免疫，
 *   是业界标准做法（也是 同类框架 那类系统常用的融合方式）。
 *
 * 另一个附带好处：**没配向量模型时召回不再直接失效**——稀疏那一路照样能跑。
 */

/**
 * 分词：中文按「连续汉字串的二字组」切，拉丁字母/数字按词切。
 *
 * 中文不用分词器也能工作的原因：二字组（bigram）已经足够区分——
 * 「胡萝卜蛋糕」→ 胡萝 / 萝卜 / 卜蛋 / 蛋糕，查「胡萝卜」命中前两个。
 * 单个孤立的汉字也保留（否则单字查询永远查不到）。
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  for (const m of s.matchAll(/[a-z0-9_]+/g)) out.push('w:' + m[0])
  for (const m of s.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      out.push('c:' + run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push('b:' + run.slice(i, i + 2))
  }
  return out
}

/**
 * BM25 稀疏检索。
 *
 * `minRatio` 是**相对**下限（默认 0.35）：只保留分数 ≥ 最高分 35% 的条目。
 * 为何不用绝对分：同一条相关命中在 N=2 的语料里只有 1.22 分，
 * 在 N=101 的语料里却到 6.02 分——BM25 打分本身强烈依赖语料规模，
 * 写死一个绝对阀值一定会在某个规模上错杀或放水。相对值则与规模无关。
 *
 * @param {Array<{id:string,text:string}>} docs 语料（单用户记忆规模，几十到几百条，直接现算）
 * @param {string} query
 * @param {object} [opts] { k, k1, b, minRatio }
 * @returns {Array<{id, score}>} 按分降序
 */
export function bm25Search(docs, query, { k = 10, k1 = 1.2, b = 0.75, minRatio = 0.35 } = {}) {
  const terms = [...new Set(tokenize(query))]
  const list = Array.isArray(docs) ? docs : []
  if (!terms.length || !list.length) return []

  const N = list.length
  const tfs = []
  const lens = []
  for (const d of list) {
    const toks = tokenize(d.text)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    tfs.push(tf)
    lens.push(toks.length)
  }
  const avg = lens.reduce((a, c) => a + c, 0) / N || 1

  // 文档频率一次算完，别在文档循环里重复扫
  const df = new Map()
  for (const t of terms) {
    let n = 0
    for (const tf of tfs) if (tf.has(t)) n++
    df.set(t, n)
  }

  const hits = []
  for (let i = 0; i < N; i++) {
    let score = 0
    for (const t of terms) {
      const f = tfs[i].get(t)
      if (!f) continue
      const n = df.get(t) || 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * lens[i]) / avg)))
    }
    if (score > 0) hits.push({ id: list[i].id, score })
  }
  hits.sort((a, b2) => b2.score - a.score)
  // 相对下限：掐掉长尾（top 乘一个系数，与语料规模无关）
  const cut = hits.length ? hits[0].score * minRatio : 0
  return hits.filter((h) => h.score >= cut).slice(0, k)
}

/**
 * RRF 融合：把多路检索结果按**名次**合起来。
 * 只出现一路的结果也不会被丢掉，只是少拿一份票。
 * @param {Array<Array<{id}>>} lists 各路结果（已按相关度降序）
 * @param {object} [opts] { k, weights }
 *   k 越大越平缓（60 是常见取值）
 *   weights 可选，与 lists 一一对应：给「不完全可靠」的那一路降权。
 *   用途：稠密可用时把稀疏降权，避免 BM25 的第 1 名压过向量真正相关的命中；
 *   稠密不可用时稀疏独占满权（它就是唯一信号）。
 * @returns {Array<{id, score, from}>} from = 命中几路
 */
export function rrfFuse(lists, { k = 60, weights = null } = {}) {
  const acc = new Map()
  const src = Array.isArray(lists) ? lists : []
  src.forEach((list, li) => {
    if (!Array.isArray(list)) return
    const w = Array.isArray(weights) && Number.isFinite(weights[li]) ? weights[li] : 1
    if (!w) return
    list.forEach((hit, i) => {
      if (!hit || !hit.id) return
      const cur = acc.get(hit.id) || { id: hit.id, score: 0, from: 0 }
      cur.score += w / (k + i + 1)
      cur.from += 1
      acc.set(hit.id, cur)
    })
  })
  return [...acc.values()].sort((a, b) => b.score - a.score)
}
