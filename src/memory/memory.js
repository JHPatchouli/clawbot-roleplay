/**
 * 记忆系统：抽取（JSON 模式）→ 垃圾过滤 → 语义去重 → 入库+向量化；召回（向量检索）。
 *
 * 多租户（P7）：所有记忆归属 ownerId（= userId）。
 *   写入时打归属；列表/检索只返回「自己的 + 共享的」；删除只能删自己的。
 *
 * 一条记忆长什么样：**不是一条干巴巴的文字陈述，而是场景关联的经历**。
 *   text 事实 + scene 当时的情境氛围 + meaning/confidence 两个维度 → 加权出 score 综合分。
 *   综合分**不当闸门**，只决定召回时用什么口吻注入（[确信]/[记得]/[模糊]），
 *   用来**引导思维链走向**（确信的当事实用，模糊的只当一点印象）。
 *   详见 memory/score.js。
 *
 * 与人设的关系：
 *   记忆记的是「之后真实发生过什么」，权重高于角色卡的「初始设定」；
 *   但**冲突必须有来由**——抽取时把人设一起喂给模型，要求「与设定相反的事实必须连起因一起记」，
 *   只看得到结论、看不出起因的**不入库**（见 prompts/index.js 的 buildExtractSystem）；
 *   召回注入时再附使用说明（MEMORY_INJECT_RULES，内含优先级附注）。
 *
 * 成本控制（P7）：抽取是纯 token 消耗大户，加了四道闸——
 *   ① extractMinChars：会话文本太短（闲聊）不抽取
 *   ② maxExtractChars：只送最近一段（按尾部截取，保留最新剧情）
 *   ③ extractMaxTokens / extractMaxItems：限制输出规模
 *   ④ 去重与入库共用同一个 embedding，省掉「每个候选多调一次向量接口」
 *      （唯一的例外：带场景的条目会**多算一个**带场景的入库向量，见 retrieveText 注释）
 *
 * 召回管线：
 *   稠密（余弦）+ **稀疏（BM25）** → **RRF 融合** → 可选 **rerank** → 取 Top-K。
 *   详见 memory/retrieval.js（为何用 RRF）与 memory/rerank.js。
 *   附带好处：没配向量模型时召回不再直接失效，稀疏那一路照样能跑。
 */
import { buildExtractSystem } from '../prompts/index.js'
import { effectiveMaxTokens } from '../providers/catalog.js'
import { scopedCollection } from '../storage/scope.js'
import { toExtractText } from '../chat/history.js'
import {
  normalizeMemoryItem,
  scoreMemory,
  memoryBand,
  renderMemoryBlock,
  renderMemoryDetail,
  LEGACY_SCORE
} from './score.js'
import { bm25Search, rrfFuse } from './retrieval.js'
import { createReranker } from './rerank.js'

/** 索引用文本：记忆是场景关联的，带场景一起算向量，气氛相近时也更容易被想起来。
 *  注意**不要**把「那时：」这种显示标签算进向量：它对每条都一样，
 *  相当于给所有向量加同一个方向的常量，只会降低区分度。 */
function retrieveText({ text, scene }) {
  const s = String(scene || '').trim()
  return s ? text + '\n（' + s + '）' : text
}

/** 时间戳归一：只接受正数毫秒，其它（null/0/NaN/字符串）一律当「没有」 */
function normTime(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/**
 * 会话隔离——规则与取舍见 createMemory 里的 scopeOff/useSession/sessionOk。
 *
 * 为何要隔离：不同会话常常在演**不同的故事线**（一个日常、一个别线），
 * 记忆混在一起会让 A 线的约定搬进 B 线。所以默认一条记忆只属于抽出它的那个会话。
 */

function genId() {
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 垃圾行过滤（与主分支口径一致） */
function isGarbage(t) {
  const s = String(t || '').trim()
  if (!s || s === '无') return true
  if (s.length < 6) return true
  if (s.includes('```')) return true
  if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(s)) return true
  return false
}

export function createMemory({ store, providers, providerStore, embedder, vectorStore, config, logger }) {
  const col = store.collection('memories')
  const scoped = (userId) => scopedCollection(store, 'memories', userId)
  const memCfg = () => config.memory || {}
  // 会话隔离
  //
  // 为何要隔离：不同会话常常在演**不同的故事线**（一个日常、一个别线），
  // 记忆混在一起会让 A 线的约定搬进 B 线。所以默认一条记忆只属于抽出它的那个会话。
  //
  // 边界的定法（很重要）：**只排除明确属于别的会话的条目**；`sessionId` 为空的一律当
  // 「全局」，任何会话都看得到。为什么不反过来：导出/导入后 sessionId 会指向一个
  // 本机不存在的会话，若把它当成「别的会话」藏起来，用户会看到记忆凭空消失。
  // 宁可多显示，不可消失。
  const scopeOff = () => memCfg().scope === 'user'
  // 按配置折算实际过滤条件：scope='user' 时返回 null（不按会话过滤，回到旧行为）
  const useSession = (sessionId) => (scopeOff() ? null : sessionId || null)
  // 一条记忆在当前会话下可见吗（同上：只排除明确属于别的会话的）
  const sessionOk = (m, sessionId) => !(sessionId && m && m.sessionId && m.sessionId !== sessionId)
  // 重排是**可选**的：没配 rerank 模型时 reranker.rank() 直接返回 null，管线自动跳过
  const reranker = createReranker({ providerStore, config, logger })

  const api = {
    /**
     * 可见记忆（自己的 + 共享的），新的在前。
     * @param {string} userId
     * @param {object} [opts] { sessionId } 传了则只返回「本会话的 + 全局的」
     *   会话过滤**统一在这里过一道 scope**：传进来的 sessionId 一律按
     *   「当前会话」理解，到底过不过滤由 config.memory.scope 说了算。
     *   这样开关对所有路径都生效，调用方不需要各自记得去查配置。
     */
    list(userId = null, { sessionId = null } = {}) {
      const sid = useSession(sessionId)
      return scoped(userId)
        .list()
        .filter((m) => sessionOk(m, sid))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    },
    count(userId = null, opts = {}) {
      return api.list(userId, opts).length
    },

    /**
     * 新增记忆。
     * @param {object} [opts] { userId, characterId, embed, vector, scene, meaning, confidence, evidence, sourceFrom, sourceTo }
     *   vector 可由调用方预先算好并复用（省一次向量接口调用）
     *   scene/meaning/confidence 缺省时按「用户自己明确记下的」处理 → 综合分落在 [确信] 档
     *   evidence 是原文出处，**只做溯源**（/mem show 与检索工具会展示）
     *   sourceFrom/sourceTo 是这件事**真正发生的时间**（毫秒），由调用方按消息时间给。
     *     它与 createdAt（记忆写入时刻）是两回事：后者在导入旧对话时会变成导入时刻，完全不可用。
     *     拿不到可信时间就留 null——宁可不在注入里显示时间，也不能拿导入时刻冒充发生时刻。
     */
    async add(text, { userId = null, characterId = null, sessionId = null, embed = true, vector = null, scene = '', meaning = 1, confidence = 1, evidence = '', source = 'chat', sourceFrom = null, sourceTo = null } = {}) {
      const item = normalizeMemoryItem({ text, scene, meaning, confidence, evidence, source })
      if (!item) throw new Error('记忆内容为空')
      const tFrom = normTime(sourceFrom)
      const tTo = normTime(sourceTo) ?? tFrom
      const obj = {
        id: genId(),
        text: item.text,
        scene: item.scene,
        meaning: item.meaning,
        confidence: item.confidence,
        score: scoreMemory(item, memCfg().scoreWeights),
        evidence: item.evidence,
        source: item.source,
        sourceFrom: tFrom,
        sourceTo: tTo,
        characterId,
        sessionId: sessionId || null,
        ownerId: userId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      col.put(obj)
      let v = vector
      if (v == null && embed && embedder.ready()) {
        try {
          v = await embedder.embed(retrieveText(obj))
        } catch (e) {
          logger.warn('记忆向量化失败：', e.message)
        }
      }
      // 向量的归属必须与记忆**两边一致**，否则会出现「记忆看得到但检索不到」。
      // 会话隔离靠的是这一份 sessionId——只写在记忆上是不够的：
      // 向量检索在排序取 top-k **之前**就要按会话过滤（见 vectorStore.search）。
      if (v) vectorStore.put(obj.id, v, { characterId, ownerId: userId, sessionId: obj.sessionId })
      return obj
    },

    /** 只能删自己的（共享记忆需在存储层处理） */
    remove(id, userId = null) {
      const ok = scoped(userId).remove(id)
      if (!ok) return false
      vectorStore.remove(id)
      return true
    },

    /**
     * 删除某个会话的**独占**记忆与它们的向量（全局的、别的会话的、共享的都不动）。
     *
     * 为什么需要它：`/session del` 以前只删会话记录，
     * 对话历史、这个会话抽出来的记忆、以及它们的向量全都留在库里。
     * 而记忆是按会话隔离的——这些记忆**在哪个会话里都看不到**（成了「孤儿」），
     * 又无法用 /mem 的序号删（列表里根本不出现），只能靠外部脚本清理。
     * 所以删会话必须连带清掉属于它的数据，「删干净」和「删一半」的差别没人看得出来。
     * @returns {{memories:number, vectors:number}} 实际删掉的条数
     */
    removeSession(sessionId, { userId = null } = {}) {
      const out = { memories: 0, vectors: 0 }
      if (!sessionId) return out
      const col = scoped(userId)
      for (const m of col.list()) {
        if (m.sessionId !== sessionId) continue
        // remove() 对共享/他人的条目会返回 false —— 未删除的条目不计入结果
        if (!col.remove(m.id)) continue
        if (vectorStore.get(m.id)) {
          vectorStore.remove(m.id)
          out.vectors += 1
        }
        out.memories += 1
      }
      if (out.memories) logger.info(`已清理会话 ${sessionId} 的独占记忆 ${out.memories} 条（向量 ${out.vectors}）`)
      return out
    },
    /**
     * 给「还没有向量」的记忆补算向量。
     *
     * 为什么需要它：导入快照时**只导入记忆本体，不导入向量**——
     * 导入器的 COLLECTIONS 里根本没有 vectors，快照里的 vectors 数组被直接丢掉。
     * 没有向量的记忆会「看得到但检索不到」：稠密那一路全靠 vectorStore，
     * 只剩 BM25 关键词那一路能召回（换个说法就找不到了）；而且余弦去重对它无效，
     * 之后抽取很可能把同样的事实再记一遍。
     *
     * 为什么不直接把导出文件里的向量搬进来：文件里**没记这个向量是哪个模型算的**。
     * 换成别的向量模型混用，会得到「看起来能检索、实际相似度全是噪声」的坏数据，
     * 而且从表现上根本查不出来。宁可花几次 embedding 调用重算。
     *
     * 幂等：已经有向量的条目直接跳过（重复导入/重复调用不会浪费调用）。
     * @returns {Promise<{embedded:number, failed:number, skipped:number}>}
     */
    async reembed(ids, { userId = null } = {}) {
      const out = { embedded: 0, failed: 0, skipped: 0 }
      const list = Array.isArray(ids) ? ids : []
      if (!list.length) return out
      if (!embedder || !embedder.ready()) {
        out.skipped = list.length
        return out
      }
      const col = scoped(userId)
      for (const id of list) {
        const obj = col.get(id)
        if (!obj || vectorStore.get(id)) {
          out.skipped += 1
          continue
        }
        try {
          const v = await embedder.embed(retrieveText(obj))
          if (!v || !v.length) {
            out.failed += 1
            continue
          }
          // 归属必须与记忆两边一致，否则会出现「记忆看得到但检索不到」（同 add 里的注释）
          vectorStore.put(id, v, { characterId: obj.characterId, ownerId: obj.ownerId ?? userId, sessionId: obj.sessionId })
          out.embedded += 1
        } catch (e) {
          out.failed += 1
          logger.warn('记忆向量重算失败 ' + id + '：' + e.message)
        }
      }
      if (out.embedded || out.failed) {
        logger.info(`记忆向量重算：成功 ${out.embedded} · 失败 ${out.failed} · 跳过 ${out.skipped}`)
      }
      return out
    },

    /** 清空自己的记忆（不动共享的）。
     *  @param {object} [opts] { sessionId, all }
     *   传 sessionId（且 all 不为 true）时**只清本会话的**，不动全局与别的会话——
     *   与 /mem 列表所见一致，避免“看着清了 3 条，实际把整个账号清了”。
     */
    clear(userId = null, { sessionId = null, all = false } = {}) {
      const sid = useSession(sessionId)
      const ids = scoped(userId)
        .listOwn()
        .filter((m) => all || !sid || m.sessionId === sid)
        .map((m) => m.id)
      for (const id of ids) {
        col.remove(id)
        vectorStore.remove(id)
      }
      return ids.length
    },

    /**
     * 把某些记忆提升为**全局**（跨会话可见），或（sessionId 传 null 时）收回当前会话。
     *
     * 为何需要它：会话隔离一旦打开，/session new 就是一个空白脑子——
     * 但总有“这条得让所有会话都记得”的情况（比如对方的名字、硬约定）。
     * 提升之后注入时不再带会话过滤，与旧行为一致。
     * @returns {number} 改动条数
     */
    promote(ids, { userId = null, sessionId = null } = {}) {
      const target = sessionId || null
      let n = 0
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const m = col.get(id)
        if (!m || (m.ownerId && m.ownerId !== userId)) continue
        if ((m.sessionId || null) === target) continue
        col.put({ ...m, sessionId: target, updatedAt: Date.now() })
        // 向量的会话归属必须跟着改，否则会出现「列表里看到了、但检索永远查不到」
        const v = vectorStore.get(id)
        if (v) vectorStore.put(id, v.vector, { characterId: v.characterId, ownerId: v.ownerId, sessionId: target })
        n++
      }
      return n
    },

    search(kw, { userId = null, limit = 30, sessionId = null } = {}) {
      const k = String(kw || '')
      const all = api.list(userId, { sessionId })
      if (!k) return all.slice(0, limit)
      return all.filter((m) => m.text.includes(k)).slice(0, limit)
    },

    /**
     * 清理孤立向量：向量还在，但对应的记忆已经不存在了。
     *
     * 为何会产生：记忆的删除有两条路径——memory.remove/clear 会连向量一起删，
     * 但**外部直接清 memories 集合**（如历史版本的 /import replace 清了记忆却没清向量）
     * 会留下孤立向量。它们在召回时会被 col.get() 过滤掉（不造成错乱），但会白占存储。
     */
    pruneOrphans(userId = null) {
      const vcol = store.collection('vectors')
      const removed = []
      for (const v of vcol.list()) {
        // 传了 userId 时，只动「自己的」；其他用户的向量不碰
        if (userId && v.ownerId && v.ownerId !== userId) continue
        if (col.get(v.id)) continue
        vcol.remove(v.id)
        removed.push(v.id)
      }
      return removed
    },

    /** 与已有记忆语义去重（单独调用会多消耗一次 embedding；抽取路径请传 vector 复用） */
    async isDuplicate(text, { userId = null, characterId = null, sessionId = null, vector = null } = {}) {
      if (!embedder.ready()) return false
      const threshold = memCfg().dedupeThreshold ?? 0.86
      try {
        const v = vector || (await embedder.embed(text))
        const hits = vectorStore.search(v, { k: 1, threshold, characterId, ownerId: userId, sessionId: useSession(sessionId) })
        return hits.length > 0
      } catch (_) {
        return false
      }
    },

    /** 从对话抽取记忆并入库（带成本闸门）
     * @param {object} [opts] { userId, characterId, character, minChars, sourceFrom, sourceTo }
     *   character 会随提示词一起给抽取器，用于判断某条事实是否「与设定相反」
     *   minChars 可覆盖配置里的阈值（调用方在本轮对方明确要求记住时会调低）
     *   sourceFrom/sourceTo 是这段对话发生在什么时候（由 chat/history.toExtractText 算出），
     *     会写进每条新记忆。一片文本里可能聊到好几件事，所以给的是**区间**，
     *     与 同类框架 的 `Source time: <区间>` 同思路：宁可给得粗，也不逐条猜。
     */
    async extractFromConversation(conversationText, { userId = null, characterId = null, sessionId = null, character = null, minChars = null, sourceFrom = null, sourceTo = null } = {}) {
      const cfg = memCfg()
      const text = String(conversationText || '').trim()
      if (!text) return []

      // 闸门 ①：太短不抽（闲聊没有可记忆的事实，白白烧 token）
      const gate = minChars ?? cfg.extractMinChars ?? 200
      if (text.length < gate) {
        logger.info(`记忆抽取跳过：会话文本 ${text.length} 字 < 阈值 ${gate} 字`)
        return []
      }
      // 闸门 ②：只送最近一段（保留最新剧情）
      const maxChars = cfg.maxExtractChars ?? 4000
      const payload = text.length > maxChars ? text.slice(-maxChars) : text

      const res = await providers.chatJson({
        messages: [
          { role: 'system', content: buildExtractSystem(character) },
          { role: 'user', content: payload }
        ],
        // 预算：配了就用配置，没配就跟随该模型最高值（上限不是预留，不花钱）
        maxTokens: effectiveMaxTokens(cfg.extractMaxTokens, providers.activeId)
      })
      // 没拿到可用 JSON 时**必须留痕**。以前这里直接当成「没有可记忆的事实」，
      // 日志上只有「候选 0，入库 0」——与「模型压根没返回 JSON」完全分不清，
      // 于是「记忆一直不涨」会被误判成「闲聊没什么好记的」。
      const raw = res && res.json && Array.isArray(res.json.memories) ? res.json.memories : []
      if (!raw.length && !(res && res.json)) {
        logger.warn(
          '记忆抽取：模型没有返回可用的 JSON，本次不新增' +
            (res && res.escalated ? '（已自动把预算提到 ' + res.escalated + ' 仍失败）' : '') +
            '｜content ' + String((res && res.text) || '').length + ' 字' +
            '｜completion ' + ((res && res.usage && res.usage.completion) || '?') +
            '／上限 ' + effectiveMaxTokens(cfg.extractMaxTokens, providers.activeId)
        )
      }
      // 归一化（兼容旧的纯字符串格式、字段别名、越界数值）；没有事实内容的条目直接丢掉
      const items = raw.map(normalizeMemoryItem).filter(Boolean)
      // 闸门 ③：限制入库条数
      const maxItems = cfg.extractMaxItems ?? 20
      const threshold = cfg.dedupeThreshold ?? 0.86
      // 去重也要按会话：不同会话是在演不同故事线，同一句话在 B 线里算新信息，
      // 不该因为 A 线记过就被当成重复而丢掉。
      const sid = useSession(sessionId)
      // 综合分**默认不当闸门**（minStoreScore=0）：低于它的才丢，用来挡模型偶尔吐的纯噪音
      const minScore = cfg.minStoreScore ?? 0
      const withScene = cfg.sceneInVector !== false
      const stored = []
      for (const item of items.slice(0, maxItems)) {
        if (isGarbage(item.text)) continue
        const sc = scoreMemory(item, cfg.scoreWeights)
        if (sc < minScore) {
          logger.info(`记忆丢弃（综合分 ${sc.toFixed(2)} < ${minScore}）：` + item.text.slice(0, 40))
          continue
        }
        // 闸门 ④：一次 embedding 同时用于去重与入库
        //   去重按**纯事实**比：同一件事换个场景说，仍然算重复
        let vFact = null
        if (embedder.ready()) {
          try {
            vFact = await embedder.embed(item.text)
          } catch (e) {
            logger.warn('记忆向量化失败：', e.message)
          }
        }
        if (vFact && vectorStore.search(vFact, { k: 1, threshold, characterId, ownerId: userId, sessionId: sid }).length > 0) continue
        // 入库向量带上场景（只在确实有场景时多算一次），让「气氛相近」也能召回
        const rt = retrieveText(item)
        let vStore = vFact
        if (vFact && withScene && rt !== item.text) {
          try {
            vStore = await embedder.embed(rt)
          } catch (_) {
            vStore = vFact
          }
        }
        stored.push(
          await api.add(item.text, {
            userId,
            characterId,
            sessionId,
            vector: vStore,
            scene: item.scene,
            meaning: item.meaning,
            confidence: item.confidence,
            evidence: item.evidence,
            sourceFrom,
            sourceTo
          })
        )
      }
      const scores = stored.map((m) => Number(m.score).toFixed(2)).join('/')
      logger.info(
        `记忆抽取：候选 ${items.length}，入库 ${stored.length}（文本 ${payload.length} 字` +
          (scores ? '｜综合分 ' + scores : '') +
          '）'
      )
      return stored
    },

    /**
     * 从一整段历史里补记忆（导入会话后用）。
     *
     * 为什么不能直接调 extractFromConversation：它只送**最后** maxExtractChars 字
     * （默认 4000）。导入的历史动辄几万字，整段丢进去 = 前面全被截掉，
     * 「补记忆」实际变成「只补最后几轮」，等于没补——而这件事从返回值上看不出来
     * （它照样会返回几条新记忆，让人以为成功了）。
     *
     * 所以按**轮次边界**切片（不让一句话被切两半），逐片抽取；
     * 片与片之间留一点重叠，避免某条事实正好卡在两片的缝上被两边各看一半。
     *
     * 跨片重复不用自己管：每片入库前都会跟「已有的 + 前面几片刚写进去的」比一次向量。
     *
     * @returns {Promise<{added:Array, chunks:number, chars:number}>}
     */
    async backfillFromMessages(messages, { userId = null, characterId = null, sessionId = null, character = null, chunkChars = null, overlapTurns = 1, onProgress = null } = {}) {
      const cfg = memCfg()
      // 单片上限必须**小于**抽取器自己的截断线，否则片内后半段还是会被无声丢掉
      const hardMax = cfg.maxExtractChars ?? 4000
      const size = Math.max(400, Math.min(Number(chunkChars) || 2600, hardMax))

      // ① 拍平成行（兼容 content / text 两种字段名）；保留 at/atUnknown，
      //    后面要靠 toExtractText 把可信时间前缀和区间算出来
      const lines = []
      for (const m of Array.isArray(messages) ? messages : []) {
        const text = String((m && (m.content ?? m.text)) || '').trim()
        if (!text) continue
        lines.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text, at: m && m.at, atUnknown: !!(m && m.atUnknown) })
      }
      // ② 归成轮次：一条 user 起头，后面跟的 assistant 都算同一轮
      const turns = []
      for (const ln of lines) {
        if (ln.role === 'user' || !turns.length) turns.push([ln])
        else turns[turns.length - 1].push(ln)
      }
      // ③ 按轮次攒片（切口落在轮次起点，不会把一轮对话切两半）
      const turnsLen = (ts) => ts.reduce((a, t) => a + t.reduce((b, x) => b + x.content.length + 12, 0), 0)
      const chunks = []
      let cur = []
      let len = 0
      for (const t of turns) {
        const tl = turnsLen([t])
        if (cur.length && len + tl > size) {
          chunks.push(cur)
          cur = overlapTurns > 0 ? cur.slice(-overlapTurns) : []
          len = turnsLen(cur)
        }
        cur.push(t)
        len += tl
      }
      if (cur.length) chunks.push(cur)

      const out = { added: [], chunks: chunks.length, chars: lines.reduce((a, x) => a + x.content.length, 0) }
      for (let i = 0; i < chunks.length; i++) {
        // 每片各算各的时间区间：跨天的片会显示成区间，无时间的片就什么都不写
        const { text: conv, from, to } = toExtractText(chunks[i].flat())
        if (onProgress) {
          try {
            await onProgress({ index: i + 1, total: chunks.length, chars: conv.length })
          } catch (_) {}
        }
        // minChars 传 1：切多大是我们自己决定的，不该再被「文本太短不抽」那道闸门挡一次
        const added = await api.extractFromConversation(conv, { userId, characterId, sessionId, character, minChars: 1, sourceFrom: from, sourceTo: to })
        out.added.push(...(added || []))
      }
      logger.info(
        `记忆回填：${lines.length} 条消息 / ${out.chars} 字 → ${out.chunks} 片，新增 ${out.added.length} 条`
      )
      return out
    },

    /**
     * 当场记住（供 `remember` 工具用）。
     *
     * 为何要绕开抽取管线：抽取有一整排闸门——每 N 轮才触发一次、
     * 增量还得凑够 extractMinChars、再由模型自己判断「值不值得记」。
     * 于是「我让你记住 xx」这种**明确要求**也可能沾不上：要么拖几轮，要么被当成不重要丢掉。
     * 这里直接写：不卡周期、不卡长度，意义/置信度按「亲口要求」给满。
     *
     * 仍然保留两道闸：垃圾行过滤与**语义去重**（也顺带拦住「工具写完又被周期抽取再记一遍」）。
     * @returns {{ok:boolean, duplicate?:boolean, memory?:object, reason?:string}}
     */
    async rememberNow(text, { userId = null, characterId = null, sessionId = null, scene = '', source = 'chat', sourceFrom = null } = {}) {
      const item = normalizeMemoryItem({ text, scene, meaning: 1, confidence: 1, source })
      if (!item) return { ok: false, reason: 'empty' }
      if (isGarbage(item.text)) return { ok: false, reason: 'garbage' }
      const cfg = memCfg()
      const threshold = cfg.dedupeThreshold ?? 0.86
      const sid = useSession(sessionId)
      let vFact = null
      if (embedder.ready()) {
        try {
          vFact = await embedder.embed(item.text)
        } catch (e) {
          logger.warn('记忆向量化失败：', e.message)
        }
      }
      if (vFact && vectorStore.search(vFact, { k: 1, threshold, characterId, ownerId: userId, sessionId: sid }).length) {
        return { ok: true, duplicate: true }
      }
      const rt = retrieveText(item)
      let vStore = vFact
      if (vFact && cfg.sceneInVector !== false && rt !== item.text) {
        try {
          vStore = await embedder.embed(rt)
        } catch (_) {
          vStore = vFact
        }
      }
      const obj = await api.add(item.text, {
        userId,
        characterId,
        sessionId,
        vector: vStore,
        scene: item.scene,
        meaning: 1,
        confidence: 1,
        evidence: item.evidence,
        source: item.source,
        // 「当场记住」= 对方刚刚说的，所以时间就是现在。这个是**真的**，
        // 不是导入时刻冒充的（见 chat/history.js messageTime）
        sourceFrom: sourceFrom ?? Date.now()
      })
      logger.info('[mem] 当场记住 1 条（来源 ' + item.source + '，回忆时综合分 ' + obj.score + '）')
      return { ok: true, memory: obj }
    },

    /**
     * 混合检索（召回管线的核心）：稠密 + 稀疏 → RRF 融合 → 可选 rerank。
     *
     * 为何两路都要（学自 同类框架）：
     *   稠密向量擅长「换个说法也能想起来」，但对专有名词/约定不敏感；
     *   BM25 擅长关键词命中（人名、地名、「靠窗的位置」这种约定），但对改写无能为力。
     *   RRF 按名次融合，零调参、对两路分数的量纲免疫（见 memory/retrieval.js）。
     *
     * 稀疏那一路用**相对**下限 `sparseMinRatio`（分数不到最高分的一定比例就不要）：
     * RRF 只看名次，若不设下限，一个无关但恰好共用一个词的记忆会靠「BM25 第 1 名」
     * 压过真正相关的稠密命中。用相对值是因为 BM25 打分本身依赖语料规模
     * （同一条命中在 N=2 里 1.22 分、在 N=101 里 6.02 分），写死绝对分必错。
     *
     * 另外给稀疏降权（`sparseWeight`）：有稠密结果时向量是主信号，稀疏只是补充。
     *
     * @returns {Promise<Array<object>>} 记忆对象（按最终相关度降序）
     */
    async retrieve(query, { userId = null, characterId = null, sessionId = null, k = 5, threshold = null } = {}) {
      const cfg = memCfg()
      const q = String(query || '').trim()
      if (!q) return []
      const sid = useSession(sessionId)
      const denseThreshold = threshold == null ? cfg.recallThreshold ?? 0.35 : threshold
      const candidates = cfg.recallCandidates ?? 20
      const sparseMinRatio = cfg.sparseMinRatio ?? 0.35
      // 可见集合（自己的 + 共享的），并按 characterId / 会话过滤——必须与向量那一路口径一致
      const visible = api
        .list(userId, { sessionId: sid })
        .filter((m) => !(characterId && m.characterId && m.characterId !== characterId))

      const denseHits = []
      const sparseHits = []
      // ① 稠密：没配向量模型就整路跳过（此时靠稀疏照样能召回，不再直接失效）
      if (cfg.hybridSearch !== false && embedder.ready()) {
        try {
          const qv = await embedder.embed(q)
          const hits = vectorStore.search(qv, {
            k: candidates,
            threshold: denseThreshold,
            characterId,
            ownerId: userId,
            sessionId: sid
          })
          for (const h of hits) denseHits.push({ id: h.id })
        } catch (e) {
          logger.warn('记忆稠密检索失败（只用稀疏）：', e.message)
        }
      }
      // ② 稀疏：BM25（中文按二字组切词，不需要分词器）
      if (cfg.hybridSearch !== false && visible.length) {
        try {
          const hits = bm25Search(
            visible.map((m) => ({ id: m.id, text: m.text + ' ' + (m.scene || '') })),
            q,
            { k: candidates, minRatio: sparseMinRatio }
          )
          for (const h of hits) sparseHits.push({ id: h.id })
        } catch (e) {
          logger.warn('记忆稀疏检索失败：', e.message)
        }
      }
      // ③ 融合：有稠密结果时给稀疏降权，否则稀疏独占满权（它是唯一信号）
      const weights = denseHits.length ? [1, cfg.sparseWeight ?? 0.5] : [1]
      const fused = denseHits.length || sparseHits.length ? rrfFuse([denseHits, sparseHits], { k: cfg.rrfK ?? 60, weights }) : []
      // 再兜一道：不管前面哪一路漏了，最终只能返回**当前可见集合**里的条目。
      // （各路的过滤口径万一不一致，这里是唯一的防线，不能让别的会话的记忆溜进注入）
      const visibleIds = new Set(visible.map((m) => m.id))
      let ordered = fused
        .map((f) => col.get(f.id))
        .filter((m) => m && visibleIds.has(m.id))
      // ④ 可选重排：只把粗排前 N 条送去重排，失败/没配就沿用原顺序
      const rerankTopN = reranker.topN()
      if (reranker.ready() && ordered.length >= 2) {
        const head = ordered.slice(0, rerankTopN)
        const ranked = await reranker.rank(q, head.map((m) => m.text))
        if (ranked && ranked.length) {
          const picked = ranked.map((r) => head[r.index]).filter(Boolean)
          const rest = ordered.slice(rerankTopN)
          // 没被重排模型选中的也保留在末尾，避免「重排漏掉的条目直接消失」
          const seen = new Set(picked.map((m) => m.id))
          ordered = picked.concat(head.filter((m) => !seen.has(m.id))).concat(rest)
        }
      }
      return ordered.slice(0, Math.max(1, k))
    },

    /** 召回：混合检索 → 按综合分分档注入（没有命中则返回 null，不注入） */
    async recall(query, { userId = null, characterId = null, sessionId = null } = {}) {
      if (!String(query || '').trim()) return null
      const cfg = memCfg()
      try {
        const mems = await api.retrieve(query, {
          userId,
          characterId,
          sessionId,
          k: cfg.recallTopK ?? 3
        })
        // 注入按综合分分档（[确信]/[记得]/[模糊]）：分数不进筛选，只决定口吻，引导思维链走向
        return renderMemoryBlock(mems)
      } catch (e) {
        logger.warn('记忆召回失败：', e.message)
        return null
      }
    },

    /**
     * 检索工具用：把命中的记忆连**场景与原文出处**一起给模型看。
     * 学自 同类框架 的做法——自动注入只给少量摘要，量大的细节留给模型按需检索。
     */
    async searchForTool(query, { userId = null, characterId = null, sessionId = null, k = 5 } = {}) {
      const hits = await api.retrieve(query, { userId, characterId, sessionId, k })
      if (!hits.length) {
        return '没有找到与「' + String(query || '').slice(0, 40) + '」相关的记忆。'
      }
      const head = '找到 ' + hits.length + ' 条相关记忆（按相关度排序，都是你自己的经历）：'
      return head + '\n' + hits.map((m, i) => renderMemoryDetail(m, { index: i + 1 })).join('\n')
    },
    /** 综合分分档统计（[确信]/[记得]/[模糊] 各多少条），供 /mem 自查；分数不进筛选，只影响注入口吻 */
    stats(userId = null, { sessionId = null } = {}) {
      const out = { total: 0, scene: 0, sure: 0, recall: 0, fuzzy: 0, avg: 0, global: 0 }
      const list = api.list(userId, { sessionId })
      if (!list.length) return out
      let sum = 0
      for (const m of list) {
        const sc = Number.isFinite(m.score) ? m.score : LEGACY_SCORE
        out.total++
        if (!m.sessionId) out.global++
        if (String(m.scene || '').trim()) out.scene++
        sum += sc
        const band = memoryBand(sc)
        if (band.key === 'sure') out.sure++
        else if (band.key === 'recall') out.recall++
        else out.fuzzy++
      }
      out.avg = Math.round((sum / list.length) * 100) / 100
      return out
    },
    rerankInfo() {
      const info = reranker.info()
      return {
        ready: reranker.ready(),
        providerId: info?.providerId || null,
        model: info?.model || '',
        topN: reranker.topN()
      }
    }
  }
  return api
}
