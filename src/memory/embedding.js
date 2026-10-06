/**
 * 向量（Embedding）：解析配置并调用 OpenAI 兼容 /embeddings。
 * 对话模型与向量模型可来自不同 Provider（默认硅基流动）。
 */
import { createEmbedding } from '../providers/client.js'

export function resolveEmbedding(providerStore, config) {
  const id = (config.embedding && config.embedding.provider) || providerStore.activeId
  const p = providerStore.get(id)
  if (!p) return null
  return {
    providerId: id,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: (config.embedding && config.embedding.model) || p.embedModel || ''
  }
}

export function isEmbeddingReady(providerStore, config) {
  const e = resolveEmbedding(providerStore, config)
  return Boolean(e && e.apiKey && e.baseUrl && e.model)
}

export function createEmbedder({ providerStore, config }) {
  return {
    ready() {
      return isEmbeddingReady(providerStore, config)
    },
    info() {
      return resolveEmbedding(providerStore, config)
    },
    async embed(input) {
      const e = resolveEmbedding(providerStore, config)
      if (!e || !e.apiKey) throw new Error('未配置向量模型（/embed model <名称> 并配置对应 Provider）')
      return createEmbedding({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model, input })
    }
  }
}
