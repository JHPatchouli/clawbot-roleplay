/**
 * 通用 JSON 存储（单文件 data/store.json）。
 *
 * 为何先用 JSON 文件而非 SQLite：
 *  - 零原生依赖，容器构建更稳（避免 better-sqlite3 预编译/编译问题）
 *  - 单用户规模足够，且天然可整体导出/导入 JSON（契合需求 5/6/7）
 *  - 对外暴露的接口（kv + collection）与后端实现解耦，
 *    后续换成 SQLite 只需替换本文件，不改调用方。
 */
import fs from 'node:fs'
import path from 'node:path'

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export class JsonStore {
  constructor(file) {
    this.file = file
    this.data = { version: 1, kv: {}, collections: {} }
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        this.data = { ...this.data, ...parsed }
        this.data.kv ||= {}
        this.data.collections ||= {}
      }
    } catch (_) {
      /* 存储损坏则从空开始 */
    }
  }

  #flush() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }

  // ---- key-value（游标、向导状态、标记等） ----
  get(key, fallback = null) {
    return key in this.data.kv ? this.data.kv[key] : fallback
  }

  set(key, value) {
    this.data.kv[key] = value
    this.#flush()
    return value
  }

  remove(key) {
    delete this.data.kv[key]
    this.#flush()
  }

  // ---- 集合（角色卡/世界书/记忆… 每个元素需含 id） ----
  collection(name) {
    this.data.collections[name] ||= {}
    const bucket = this.data.collections[name]
    const flush = () => this.#flush()
    return {
      list: () => Object.values(bucket),
      get: (id) => bucket[id] ?? null,
      put: (obj) => {
        bucket[obj.id] = obj
        flush()
        return obj
      },
      remove: (id) => {
        delete bucket[id]
        flush()
      },
      clear: () => {
        this.data.collections[name] = {}
        flush()
      },
      replaceAll: (arr) => {
        const next = {}
        for (const o of arr) if (o && o.id) next[o.id] = o
        this.data.collections[name] = next
        flush()
      }
    }
  }

  // ---- 导入导出 ----
  exportAll() {
    return structuredClone(this.data)
  }

  importAll(obj, { merge = false } = {}) {
    if (merge) {
      this.data.kv = { ...this.data.kv, ...(obj.kv || {}) }
      for (const [name, bucket] of Object.entries(obj.collections || {})) {
        this.data.collections[name] = { ...(this.data.collections[name] || {}), ...bucket }
      }
    } else {
      this.data = { version: 1, kv: obj.kv || {}, collections: obj.collections || {} }
    }
    this.#flush()
  }
}
