/**
 * 记忆重排（Rerank）：粗排召回来的一批候选，用专门的 rerank 模型按「与当前这句话的相关度」重排。
 *
 * 为什么需要：
 *   向量/BM25 都是「先算好向量再比距离」的粗排，对「这条记忆到底帮不帮得上这一轮」判断很粗；
 *   rerank 模型是 query+doc 一起过一遍，精度明显更高。同类框架 的检索链就是
 *   混合召回 → rerank → 取 Top-K。
 *
 * 三条设计约束：
 *   ① **可选**：没配 `config.rerank.model` 就直接走融合后的顺序，不报错、不拖慢；
 *   ② **永不致命**：接口失败/超时/返回乱七八糟一律退回原顺序（日志里记一条 warn）；
 *   ③ **只在候选集上跑**：只把粗排的前 `rerankTopN` 条送去重排，控成本。
 */
import { createRerank } from '../providers/client.js'

/** 解析 rerank 的 provider/model 配置 */
export function resolveRerank(providerStore, config) {
  const rc = (config && config.rerank) || {}
  // 没单独指定 rerank provider 时，优先跟着向量模型走（重排模型通常和向量模型在同一家）
  const id = rc.provider || (config && config.embedding && config.embedding.provider) || providerStore.activeId
  const p = providerStore.get(id)
  if (!p) return null
  return {
    providerId: id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: rc.model || p.rerankModel || '',
    topN: rc.topN ?? 20
  }
}

export function isRerankReady(providerStore, config) {
  const r = resolveRerank(providerStore, config)
  return Boolean(r && r.apiKey && r.baseUrl && r.model)
}

export function createReranker({ providerStore, config, logger }) {
  return {
    ready() {
      return isRerankReady(providerStore, config)
    },
    info() {
      return resolveRerank(providerStore, config)
    },
    /** 粗排候选送去重排上限 */
    topN() {
      return resolveRerank(providerStore, config)?.topN ?? 20
    },
    /**
     * 重排。永不抛错：任何异常都返回 null，让调用方保留原顺序。
     * @returns {Promise<Array<{index:number, score:number}>|null>} null = 没重排
     */
    async rank(query, documents) {
      const r = resolveRerank(providerStore, config)
      if (!r || !r.apiKey || !r.baseUrl || !r.model) return null
      const docs = Array.isArray(documents) ? documents : []
      if (docs.length < 2) return null // 只有一条没什么可排的
      try {
        const out = await createRerank({
          baseUrl: r.baseUrl,
          apiKey: r.apiKey,
          model: r.model,
          query,
          documents: docs
        })
        if (!out.length) return null
        return out
      } catch (e) {
        logger?.warn('记忆重排失败（沿用原顺序）：', e.message)
        return null
      }
    }
  }
}
