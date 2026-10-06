/**
 * Provider 配置持久化：data/providers.json（权限 0600，含 API Key）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PROVIDER_PRESETS, getPreset } from './catalog.js'

function defaultProviderState(id) {
  const preset = getPreset(id)
  return {
    id,
    baseUrl: preset?.baseUrl || '',
    apiKey: '',
    chatModel: preset?.defaultChatModel || '',
    embedModel: preset?.defaultEmbedModel || '',
    thinking: { enabled: true, budget: 0, effort: '' },
    models: [], // 最近一次发现的可用模型
    modelsUpdatedAt: 0
  }
}

export class ProviderStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'providers.json')
    this.data = { version: 1, active: 'deepseek', providers: {} }
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.data = { ...this.data, ...parsed }
      }
    } catch (_) {
      /* 损坏则用默认 */
    }
    for (const id of Object.keys(PROVIDER_PRESETS)) {
      this.data.providers[id] = { ...defaultProviderState(id), ...(this.data.providers[id] || {}) }
    }
    if (!this.data.providers[this.data.active]) this.data.active = Object.keys(PROVIDER_PRESETS)[0]
  }

  #flush() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  get activeId() {
    return this.data.active
  }

  setActive(id) {
    if (!this.data.providers[id]) throw new Error(`未知 Provider：${id}`)
    this.data.active = id
    this.#flush()
    return this
  }

  get(id = this.data.active) {
    return this.data.providers[id] || null
  }

  list() {
    return Object.values(this.data.providers)
  }

  update(id, patch) {
    const cur = this.data.providers[id]
    if (!cur) throw new Error(`未知 Provider：${id}`)
    this.data.providers[id] = { ...cur, ...patch, thinking: { ...cur.thinking, ...(patch.thinking || {}) } }
    this.#flush()
    return this.data.providers[id]
  }

  setModels(id, models) {
    return this.update(id, { models, modelsUpdatedAt: Date.now() })
  }

  /** 导入 Provider 配置（合并；仅覆盖已存在的 Provider id） */
  importProviders(providersObj = {}, { withActive = true } = {}) {
    let n = 0
    for (const [id, cfg] of Object.entries(providersObj)) {
      if (!this.data.providers[id]) continue
      const cur = this.data.providers[id]
      this.data.providers[id] = {
        ...cur,
        ...cfg,
        thinking: { ...cur.thinking, ...(cfg.thinking || {}) },
        // 占位值 '***' 不覆盖真实 key
        apiKey: cfg.apiKey && cfg.apiKey !== '***' ? cfg.apiKey : cur.apiKey
      }
      n++
    }
    this.#flush()
    return n
  }

  /** 导出（默认省略 API Key） */
  export({ withSecrets = false } = {}) {
    const clone = structuredClone(this.data)
    if (!withSecrets) {
      for (const p of Object.values(clone.providers)) if (p.apiKey) p.apiKey = '***'
    }
    return clone
  }
}
