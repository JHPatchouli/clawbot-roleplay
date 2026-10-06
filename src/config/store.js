/**
 * 设置存储：data/config.json
 * - 默认值 + 用户覆盖深合并
 * - 环境变量优先级最高
 * - 原子写入（临时文件 + rename）
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG, applyEnvOverrides } from './defaults.js'

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export class ConfigStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json')
    this.data = this.#load()
  }

  #load() {
    let user = {}
    try {
      if (fs.existsSync(this.file)) user = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (_) {
      /* 配置损坏则退回默认值 */
    }
    return applyEnvOverrides(deepMerge(DEFAULT_CONFIG, user))
  }

  get() {
    return this.data
  }

  /** 部分更新并持久化（原地更新，保持外部对 this.data 及其子对象的引用有效） */
  set(patch) {
    const next = applyEnvOverrides(deepMerge(this.data, patch))
    for (const k of Object.keys(this.data)) delete this.data[k]
    Object.assign(this.data, next)
    this.save()
    return this.data
  }

  save() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }
}
