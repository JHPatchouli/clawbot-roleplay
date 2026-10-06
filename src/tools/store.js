/**
 * 工具密钥存储：data/tools.json（0600）。
 *
 * 为什么不放进 config.json：
 *   `/export settings` 会把 config 原文导出并发到聊天里，密钥放那里等于到处可见。
 *   单独存一份、单独省略，与 providers.json（API Key）同一思路。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  // 联网搜索：provider 可选 bocha / tavily / brave / serper / searxng
  // 默认 bocha —— 本项目面向国内场景（模型也是 DeepSeek/硅基流动），
  // 中文内容覆盖与合规都更合适；自建或商用搜索服务可在配置中替换。
  web: { provider: 'bocha', apiKey: '', searxngUrl: '' }
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v
  }
  return out
}

export class ToolStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'tools.json')
    this.data = this.#load()
  }

  #load() {
    try {
      if (fs.existsSync(this.file)) {
        return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')))
      }
    } catch (_) {
      /* 损坏则回退默认值 */
    }
    return structuredClone(DEFAULTS)
  }

  get() {
    return this.data
  }

  set(patch) {
    this.data = deepMerge(this.data, patch)
    this.save()
    return this.data
  }

  save() {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch (_) {
      /* 忽略 */
    }
  }
}

/** 省略展示 */
export function maskSecret(k) {
  const s = String(k || '')
  if (!s) return '（未设置）'
  if (s.length <= 8) return '***'
  return s.slice(0, 4) + '…' + s.slice(-3)
}
