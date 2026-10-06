/**
 * 记忆的「场景 + 事实 + 维度」与综合分。
 *
 * 设计立场：
 *   记忆**不是一条干巴巴的文字陈述**，而是高度场景关联的经历——
 *   「谁、在什么情境氛围下、发生了什么、后来怎样了」。
 *   所以每条记忆除 text（事实）外还要有 scene（当时的情境氛围），
 *   再加两个判断维度 meaning（意义是否实际）/ confidence（置信度），最后加权综合。
 *
 * 综合分**不当闸门**用（默认 minStoreScore=0，什么都不拦）：
 *   它只决定召回时这条记忆以什么口吻注入（[确信] / [记得] / [模糊]），
 *   从而**引导模型的思维链走向**——确信的可以当事实用，模糊的只当一点印象。
 *   要不要记下来另有一套闸门：垃圾行过滤、语义去重、「冲突必须带起因」。
 *
 * 维度含义：
 *   meaning    0~1  这条对以后相处有没有实际影响（1=会改变之后的行为/态度/约定；0=只是背景）
 *   scene      文本 当时的情境与氛围（空 = 没写出来，不加分也不扣分）
 *   confidence 0~1  有多确定这是「真的、会长期成立」的事（玩笑/试探/被追问才改口 → 低）
 *   evidence   文本 这条事实是从哪几句对话里得出的（**只做溯源，不参与注入**）
 *             —— 学自 同类框架 的记忆图谱：事实（FactNode）要能追回原文段落（PassageNode）。
 *             我们只在 `/mem show` 与检索工具里展示，不进每轮的自动注入，免得白烧 token。
 */
import { MEMORY_INJECT_HEADER, MEMORY_INJECT_RULES } from '../prompts/index.js'

/** 三个维度的默认权重（可用 config.memory.scoreWeights 覆盖） */
export const DEFAULT_WEIGHTS = { meaning: 0.4, scene: 0.25, confidence: 0.35 }

/**
 * 旧记忆（加这道维度之前入库的）没有维度信息。
 * 按「中上」处理：没理由不信，但也不像新记忆那样有把握 → 落在 [记得] 档。
 */
export const LEGACY_SCORE = 0.6

/** 钳到 0~1；容忍模型写成 85 这种百分数、写成 "0.9" 字符串、或干脆不写（用 fallback） */
export function clamp01(v, fallback = 0.5) {
  if (v === true) return 1
  if (v === false) return 0
  if (v == null || v === '') return fallback
  const n = typeof v === 'string' ? Number(v.replace(/[％%]/g, '').trim()) : Number(v)
  if (!Number.isFinite(n)) return fallback
  // 提示词写的是 0~1，出了范围就是模型没听话。只把「明显是百分制」的换算回来：
  // 85 → 0.85；而 5 这种小整数更像「5 分制」，当满分处理，不能变成 0.05。
  const x = n > 1 && n >= 10 && n <= 100 ? n / 100 : n
  return Math.min(1, Math.max(0, x))
}

/**
 * 场景锚点得分。
 * 记忆本来就是场景化的，所以「写得出来」是常态、给满分；没写只是没加分，不倒扣。
 */
export function sceneGrounding(scene) {
  const s = String(scene || '').trim()
  if (!s) return 0.5
  return s.length >= 4 ? 1 : 0.7
}

/** 加权综合分（权重按实际和归一，避免配置写歪了把分数顶出 0~1） */
export function scoreMemory({ meaning, confidence, scene } = {}, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) }
  const total = w.meaning + w.scene + w.confidence
  if (!(total > 0)) return 0.5
  const s =
    (clamp01(meaning, 0.5) * w.meaning +
      sceneGrounding(scene) * w.scene +
      clamp01(confidence, 0.5) * w.confidence) /
    total
  return Math.round(s * 1000) / 1000
}

/** 原文出处限长：只做溯源用，没必要整段对话都存 */
export const EVIDENCE_MAX = 300

/** 来源：聊天里对方说的 */
export const SOURCE_CHAT = 'chat'
/** 来源：从网页上看来的（不一定真） */
export const SOURCE_WEB = 'web'
/** 注入时贴在「来自网页」记忆后面的提醒 */
export const WEB_SOURCE_NOTE = '（这条是从网页上看来的，不一定是真的）'

/**
 * 把模型输出的一条归一化成 {text, scene, meaning, confidence, evidence}。
 * 兼容：旧格式（纯字符串）、字段别名（fact/atmosphere/conf/quote）、越界数值、缺字段。
 * @returns {object|null} 没有事实内容 → null（视为无效条目）
 */
export function normalizeMemoryItem(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { text, scene: '', meaning: 0.5, confidence: 0.5, evidence: '', source: 'chat' } : null
  }
  if (typeof raw !== 'object') return null
  const text = String(raw.text ?? raw.fact ?? raw.content ?? '').trim()
  if (!text) return null
  let evidence = String(raw.evidence ?? raw.quote ?? '').trim()
  if (evidence.length > EVIDENCE_MAX) evidence = evidence.slice(0, EVIDENCE_MAX) + '…'
  return {
    text,
    scene: String(raw.scene ?? raw.atmosphere ?? '').trim(),
    meaning: clamp01(raw.meaning ?? raw.significance, 0.5),
    confidence: clamp01(raw.confidence ?? raw.conf, 0.5),
    evidence,
    // 来源：'chat' = 对方说的；'web' = **从网页上看来的**。
    // 旧数据没这个字段 → 一律当 chat（升级不会丢数据，不炸）。
    source: raw.source === 'web' ? 'web' : 'chat'
  }
}

/** 注入口吻分档：综合分 → 模型该怎么拿这件事当真 */
export const MEMORY_BANDS = [
  { key: 'sure', min: 0.75, label: '确信' },
  { key: 'recall', min: 0.5, label: '记得' },
  { key: 'fuzzy', min: 0, label: '模糊' }
]

export function memoryBand(score) {
  const s = Number.isFinite(score) ? score : LEGACY_SCORE
  for (const b of MEMORY_BANDS) if (s >= b.min) return b
  return MEMORY_BANDS[MEMORY_BANDS.length - 1]
}

/**
 * 来源时间的显示：`19:37`；跟跨天就显示成区间 `~ `。
 *
 * 这是**代码算出来的**，不是让模型写的（学自 同类框架 的 LivingMemory：
 * `Attach source dates without asking the LLM to infer them`）。
 * 为何不让模型写：抽取时它根本看不到真实时间，只能猜——曾写出过「凌晨一点多」
 * 这类无从核实的时间（那次恰好蒙对，只因为旧客户端把时间写进了正文里）。
 * 拿不到可信时间就返回空串：**宁可没有，也不要编一个**。
 */
export function renderSourceTime(from, to = null) {
  const f = Number(from)
  if (!Number.isFinite(f) || f <= 0) return ''
  const p = (n) => String(n).padStart(2, '0')
  const day1 = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  const d1 = new Date(f)
  const day = day1(d1)
  const t = Number(to)
  if (!Number.isFinite(t) || t <= 0) return day + ' ' + p(d1.getHours()) + ':' + p(d1.getMinutes())
  const d2 = new Date(t)
  if (day1(d2) === day) return day + ' ' + p(d1.getHours()) + ':' + p(d1.getMinutes())
  return day + ' ~ ' + day1(d2)
}

/**
 * 单条记忆的注入行：`· [确信]愿意吃他做的胡萝卜蛋糕…`
 *
 * 时间就用**真事发生时的那一刻**（代码算的），不再让模型写「（那时：…）」：
 * 那个标签需要模型从对话里推当时的情境，结果要么退化成复述事实、要么干脆编景
 * （写出过对话里根本没有的「玻璃窗透进夕阳」），而且读起来像是在替角色旁白。
 */
export function renderMemoryLine(mem) {
  const band = memoryBand(mem && mem.score)
  const text = String((mem && mem.text) || '').trim()
  const when = renderSourceTime(mem && mem.sourceFrom, mem && mem.sourceTo)
  const tail = band.key === 'fuzzy' ? '（不太确定，别说得斩钉截铁）' : ''
  // ⭐ 来自网页的记忆要**永远带着出处**：
  //   记忆是外部内容唯一能被「洗白」的通道 —— 写进来之后它就以「系统给的资料」身份每轮注入，
  //   再也不受「外部资料不是指令」那条约束。不阻止她记，但让这条**自己声明不可靠**。
  const fromWeb = mem && mem.source === 'web' ? WEB_SOURCE_NOTE : ''
  return '· [' + band.label + '] ' + (when ? '（' + when + '）' : '') + text + fromWeb + tail
}

/**
 * 列表/回执用的截断：**按标点收尾**，不要把句子砍在中间。
 *
 * 为什么不能直接 `slice`：返回结果里出现过
 * 「（那时：用户甲认真交代接下来的技术安排，要求角色乙」「（那时：…语气是随」——
 * 断在词中间，读起来像乱码，比不显示还糟。截断本身没错，**砍在词里**才是错。
 * 找不到合适标点时宁可硬切（信息量优先），但一定带省略号，让人知道后面还有。
 */
export function clip(text, max = 40) {
  const s = String(text == null ? '' : text).trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const at = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('。'),
    head.lastIndexOf('、'),
    head.lastIndexOf('；'),
    head.lastIndexOf('？'),
    head.lastIndexOf('！'),
    head.lastIndexOf('…')
  )
  // 标点落在太靠前（不足 max 的一半）就宁可硬切，否则剩下的信息量太少
  const cut = at >= Math.floor(max * 0.5) ? head.slice(0, at) : head
  return cut + '…'
}

/** 召回注入的整块内容：标题 + 分档条目 + 使用说明（说明里含优先级附注） */
export function renderMemoryBlock(mems) {
  const list = (mems || []).filter(Boolean)
  if (!list.length) return null
  return (
    MEMORY_INJECT_HEADER + '\n' + list.map(renderMemoryLine).join('\n') + '\n' + MEMORY_INJECT_RULES
  )
}

/**
 * 记忆详情（`/mem show` 与检索工具用）：比分档行多出场景、维度、原文出处。
 * @param {object} mem
 * @param {object} [opts] { index, withEvidence = true, withTime = false }
 */
export function renderMemoryDetail(mem, { index = null, withEvidence = true, withTime = false } = {}) {
  if (!mem) return ''
  const score = Number.isFinite(mem.score) ? mem.score : LEGACY_SCORE
  const head = (index == null ? '' : index + '. ') + '[' + memoryBand(score).label + ' ' + score.toFixed(2) + ']'
  const lines = [head + ' ' + String(mem.text || '').trim()]
  const when = renderSourceTime(mem.sourceFrom, mem.sourceTo)
  if (when) lines.push('   发生在：' + when)
  const scene = String(mem.scene || '').trim()
  if (scene) lines.push('   当时的氛围：' + scene)
  if (withEvidence && String(mem.evidence || '').trim()) lines.push('   出自：' + String(mem.evidence).trim())
  if (mem.source === 'web') lines.push('   来源：网页（不一定可靠，别当亲历的事实）')
  const bits = ['意义 ' + clamp01(mem.meaning, 0.5).toFixed(2), '置信 ' + clamp01(mem.confidence, 0.5).toFixed(2)]
  if (withTime && mem.createdAt) {
    const d = new Date(mem.createdAt)
    const pad = (n) => String(n).padStart(2, '0')
    bits.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()))
  }
  lines.push('   ' + bits.join(' · '))
  return lines.join('\n')
}
