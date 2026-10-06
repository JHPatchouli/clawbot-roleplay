/**
 * 导入器：把各类 JSON 解析为我们的存储集合（characters / lorebook / memories）。
 * 复用主分支的数据模型，保证跨设备迁移可用。
 *
 * 多租户（P7）：导入的条目归属导入者（ownerId = userId）；
 * 「覆盖导入」只清自己的条目，不会抹掉共享数据或其他用户的数据。
 */
import { detectKind, kindLabel } from './kinds.js'
import { scopedCollection } from '../storage/scope.js'
import { normalizeMemoryItem, scoreMemory } from '../memory/score.js'

const COLLECTIONS = ['characters', 'lorebook', 'memories']
const ID_PREFIX = { characters: 'c', lorebook: 'l', memories: 'm' }

/**
 * 会写入全局系统设置 / Provider 的导入类型。
 * 这些操作不可撤销，命令层（/import）要求二次确认。
 */
export const DOUBLE_CONFIRM_KINDS = ['settings', 'providers', 'backup']

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 归一化角色（主分支字段 → 我们的字段） */
function normalizeCharacter(c) {
  const now = Date.now()
  return {
    id: c.id || genId('c'),
    name: (c.name || '').trim() || '未命名角色',
    description: c.description || '',
    personality: c.personality || '',
    scenario: c.scenario || '',
    firstMes: c.firstMes ?? c.first_mes ?? '',
    mesExample: c.mesExample ?? c.mes_example ?? '',
    systemPrompt: c.systemPrompt ?? c.system_prompt ?? '',
    creatorNotes: c.creatorNotes ?? c.creator_notes ?? '',
    createdAt: c.createdAt || now,
    updatedAt: now
  }
}

function normalizeLore(e) {
  const now = Date.now()
  const keys = Array.isArray(e.keys) ? e.keys : typeof e.keys === 'string' ? e.keys.split(/[,，\n]/) : []
  return {
    id: e.id || genId('l'),
    title: (e.title || e.comment || e.name || '').trim() || '未命名设定',
    keys: keys.map((k) => String(k).trim()).filter(Boolean),
    content: e.content || '',
    active: Boolean(e.active ?? e.enabled ?? e.constant),
    priority: Number(e.priority ?? e.insertion_order ?? 0) || 0,
    createdAt: e.createdAt || now,
    updatedAt: now
  }
}

function normalizeMemory(m) {
  const now = Date.now()
  // 记忆是「场景 + 事实 + 维度」（见 memory/score.js）：导出再导入不能把这些字段丢掉，
  // 否则一次往返就把场景与置信度洗成默认值（旧快照没有这些字段→归一化会给中值）
  const item = normalizeMemoryItem({
    text: m.text,
    scene: m.scene,
    meaning: m.meaning,
    confidence: m.confidence
  })
  if (!item) return null
  return {
    id: m.id || genId('m'),
    text: item.text,
    scene: item.scene,
    meaning: item.meaning,
    confidence: item.confidence,
    score: Number.isFinite(m.score) ? m.score : scoreMemory(item),
    tags: Array.isArray(m.tags) ? m.tags : [],
    characterId: m.characterId || null,
    // 来源时间是**代码记录的事实**，丢了就再也没法重建（不像 score 能重算）
    sourceFrom: parseMs(m.sourceFrom),
    sourceTo: parseMs(m.sourceTo),
    // 会话归属也要先带过来：applyImport 会把它清成全局（因为那是导出方的会话），
    // 但得先看得见它才能统计出「有几条被转了」，也才能让往返不丢字段
    sessionId: m.sessionId || null,
    createdAt: m.createdAt || now,
    updatedAt: now
  }
}

/** Character Card V2 → 角色 + 内嵌世界书 */
function fromCharacterCard(obj) {
  const d = obj.data && typeof obj.data === 'object' ? obj.data : obj
  const character = normalizeCharacter({
    name: d.name,
    description: d.description,
    personality: d.personality,
    scenario: d.scenario,
    firstMes: d.first_mes ?? d.firstMes,
    mesExample: d.mes_example ?? d.mesExample,
    systemPrompt: d.system_prompt ?? d.systemPrompt,
    creatorNotes: d.creator_notes ?? d.creatorNotes
  })
  const entries = d.character_book?.entries
  const lorebook = Array.isArray(entries)
    ? entries.map((e) => normalizeLore({ title: e.comment || e.name, keys: e.keys, content: e.content, active: e.enabled ?? e.constant, priority: e.insertion_order }))
    : []
  return { characters: [character], lorebook, memories: [] }
}

/** 全量快照 → 归一化 */
function fromSnapshot(obj) {
  const d = obj.data || {}
  return {
    characters: Array.isArray(d.characters) ? d.characters.map(normalizeCharacter) : [],
    lorebook: Array.isArray(d.lorebook) ? d.lorebook.map(normalizeLore) : [],
    memories: Array.isArray(d.memories) ? d.memories.map(normalizeMemory) : []
  }
}

/** 解析导出里的时间字段（毫秒数 / 秒级时间戳 / ISO 字符串）→ 毫秒数；认不出返回 null。
 *  ⚠️ **不要兜底成「现在」**：那会把导入时刻冒充成消息的发生时间，
 *  记忆会集体装成“都是今天发生的”（见 chat/history.js 的 messageTime）。 */
function parseMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // 秒级时间戳（10 位）也接受，统一乘到毫秒
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return null
}

/**
 * 会话导出兼容层：把历史上出现过的两种外形拍平成同一种内部结构。
 *
 * 为什么要它：会话导出实际有两种外形——
 *   ① 本项目 ClawBot：{ kind:'app-session', session:{name}, messages:[{role,content,reasoning}] }
 *      —— 消息在**顶层**
 *   ② 主分支 / Web 端：{ format:'app-session', session:{ name, createdAt, messages:[{role,text,time}] } }
 *      —— 消息**嵌在 session 里**，而且正文叫 text 不叫 content
 * `detectKind` 两种都认得出来（都返回 app-session），但导入器只实现了 ①，
 * 于是 ② 会走到「等待导入 → 暂不支持导入该类型」。凡是「识别通过、导入落空」的分歧，
 * 都要在这一层抹平，不能指望调用方各自记得两套字段名。
 */
export function normalizeSessionPayload(obj = {}) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const sess = o.session && typeof o.session === 'object' ? o.session : {}
  const raw = Array.isArray(o.messages) ? o.messages : Array.isArray(sess.messages) ? sess.messages : []
  const messages = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    // 历史只承载「聊天轮次」（见 chat/history.js）。导出里若混进 system 等其它角色，
    // 这里**丢掉**而不是降级成 user——把它当成 user 的发言塞进角色扮演，
    // 等于让一段系统指令冒充对方说过的话，比丢掉更糟。
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = String(m.content ?? m.text ?? '').trim()
    // 空轮次不导入：它们只会让记忆抽取看到一堆没有说话内容的角色标签，白烧 token
    if (!content) continue
    const ms = parseMs(m.at ?? m.time)
    const item = { role: m.role, content }
    // 源文件没带时间 → 打上记号，**不要**填一个假的
    if (ms == null) item.atUnknown = true
    else item.at = ms
    // 思考链与工具轨迹要在往返里保住（之前导入会把它们静默丢掉）
    if (m.reasoning) item.reasoning = String(m.reasoning)
    if (Array.isArray(m.tools) && m.tools.length) item.tools = m.tools
    messages.push(item)
  }
  return {
    name: String(sess.name || o.name || '导入会话').trim() || '导入会话',
    createdAt: parseMs(sess.createdAt) ?? parseMs(o.exportedAt) ?? Date.now(),
    messages
  }
}

/** 预览：解析并给出摘要（不改动存储） */
export function previewImport(obj) {
  const kind = detectKind(obj)
  if (kind === 'unknown') return { kind, label: kindLabel(kind), counts: null }

  if (kind === 'settings') return { kind, label: kindLabel(kind), counts: { 设置: 1 }, preview: { characters: [] } }
  if (kind === 'providers') return { kind, label: kindLabel(kind), counts: { Provider: Object.keys(obj.providers || {}).length }, preview: { characters: [] } }
  if (kind === 'session' || kind === 'app-session') {
    // 两种外形都归一成 kind:'session'，让调用方只认一种
    const s = normalizeSessionPayload(obj)
    const users = s.messages.filter((m) => m.role === 'user').length
    return {
      kind: 'session',
      label: kindLabel(kind),
      session: s,
      messages: s.messages,
      counts: { 消息: s.messages.length, 对方: users, 角色: s.messages.length - users },
      preview: { characters: [] }
    }
  }
  if (kind === 'backup') {
    const rp = obj.roleplay || {}
    return {
      kind,
      label: kindLabel(kind),
      counts: {
        角色: (rp.characters || []).length,
        世界书: (rp.lorebook || []).length,
        记忆: (rp.memories || []).length,
        会话: (obj.sessions || []).length
      },
      preview: { characters: (rp.characters || []).slice(0, 5).map((c) => c.name) }
    }
  }

  let data
  if (kind === 'roleplay-snapshot') data = fromSnapshot(obj)
  else if (kind === 'character-card') data = fromCharacterCard(obj)
  else return { kind, label: kindLabel(kind), unsupported: true, counts: null }
  const counts = {
    characters: data.characters.length,
    lorebook: data.lorebook.length,
    memories: data.memories.length
  }
  return { kind, label: kindLabel(kind), counts, data, preview: { characters: data.characters.slice(0, 5).map((c) => c.name) } }
}

/**
 * 应用导入。
 * @param {object} store JsonStore
 * @param {object} obj 原始 JSON
 * @param {object} opts { mode: 'merge'|'replace', userId }
 */
export function applyImport(store, obj, { mode = 'merge', userId = null } = {}) {
  const p = previewImport(obj)
  if (p.kind === 'unknown') throw new Error('无法识别的文件类型')
  if (p.unsupported) throw new Error(`暂不支持导入${p.label}`)

  if (mode === 'replace') {
    // 只清「自己的」条目：共享条目与其他用户的数据不能被一次导入抹掉。
    //
    // 记忆例外：只有导入文件**确实带了记忆**时才清。
    // 理由：记忆是聊出来的累积经验，不属于角色卡/快照的配置内容；
    // 而角色卡里 memories 一贯是空的，按旧逻辑会把累积的记忆连带清空
    // 。
    // 需要显式清空记忆请用 /mem clear。
    for (const name of COLLECTIONS) {
      if (name === 'memories' && !p.data.memories.length) continue
      scopedCollection(store, name, userId).clearOwn()
    }
  }
  const counts = { characters: 0, lorebook: 0, memories: 0, globalized: 0 }
  // 导入的记忆 id（供调用方补算向量）。
  // ⚠️ 快照里那份 `vectors` 是**不导入**的：COLLECTIONS 里没有 vectors，
  //    而且文件里没记这些向量是哪个模型算的，混用别的模型的向量会得到
  //    「看着能检索、其实全是噪声」的数据。导入后由 memory.reembed 重算。
  const memoryIds = []
  // 实际写进去的角色（id 可能因为被他人占用而重新分配，所以不能拿 p.data 里那份当结果）
  const charList = []
  for (const name of COLLECTIONS) {
    const col = store.collection(name)
    for (const item of p.data[name]) {
      // 记忆没有事实内容就不算条目（normalizeMemory 会给出 null）
      if (name === 'memories' && (!item || !item.text)) continue
      // id 被其他用户占用时重新分配，避免相互覆盖
      const existing = col.get(item.id)
      const id = existing && existing.ownerId !== userId ? genId(ID_PREFIX[name] || 'i') : item.id
      // 记忆的 sessionId 指向**导出方**的会话，在本机多半不存在。
      // 留着就等于把这些记忆藏进一个没人进得去的会话里（等于丢了）：
      // 列表看不到、检索也查不到。所以导入一律清成「全局」——宁可多显示，不可消失。
      if (name === 'memories') {
        if (item.sessionId) counts.globalized += 1
        col.put({ ...item, id, ownerId: userId, sessionId: null })
        memoryIds.push(id)
      } else {
        col.put({ ...item, id, ownerId: userId })
        if (name === 'characters') charList.push({ id, name: item.name })
      }
      counts[name] += 1
    }
  }
  return {
    kind: p.kind,
    mode,
    counts,
    memoryIds,
    characters: charList
  }
}

/** 导出快照（自己的 + 共享的，与 /char list 所见一致） */
export function exportSnapshot(store, userId = null) {
  const data = {}
  for (const name of COLLECTIONS) {
    // 去掉 scopedCollection 为展示而加的 shared 标记，保持导出格式干净
    data[name] = scopedCollection(store, name, userId)
      .list()
      .map(({ shared, ...rest }) => rest)
  }
  return { app: 'demo', kind: 'roleplay-snapshot', version: 1, exportedAt: Date.now(), data }
}

/** 把嵌套对象拍平成 { 'a.b': value } */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? prefix + '.' + k : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out)
    else out[path] = v
  }
  return out
}

/**
 * 比较两份系统设置，列出将要变更的键（含嵌套路径）。
 * 用途：设置导入的二次确认——先让用户看到「旧值 → 新值」再决定是否写入。
 * @returns {Array<{key:string, from:any, to:any}>}
 */
export function diffConfig(oldCfg = {}, newCfg = {}) {
  const a = flatten(oldCfg)
  const b = flatten(newCfg)
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const changes = []
  for (const key of keys) {
    const from = a[key]
    const to = b[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    changes.push({ key, from, to })
  }
  return changes
}

/** 变更项的单行展示（超长截断） */
export function formatDiff(changes, limit = 12) {
  const fmt = (v) => {
    if (v === undefined) return '（无）'
    if (v === null) return 'null'
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return s.length > 40 ? s.slice(0, 40) + '…' : s
  }
  const shown = changes.slice(0, limit).map((c) => '· ' + c.key + '：' + fmt(c.from) + ' → ' + fmt(c.to))
  if (changes.length > limit) shown.push('· …共 ' + changes.length + ' 项变更')
  return shown
}
