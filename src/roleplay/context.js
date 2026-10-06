/**
 * 角色扮演 · 上下文组装
 * system(人设) + system(触发世界书) + 历史对话  →  返回 messages
 * 注意：只接受「聊天历史」，命令流量不会进入（见 chat/history.js）。
 */
import { buildCharacterSystemPrompt } from './prompts.js'
import { getTriggeredLore } from './lorebook.js'

/** 记忆注入的两种摆法 */
export const MEMORY_PLACEMENT = {
  /** 挂在本轮用户输入之后（默认）——保住 system 段的前缀缓存 */
  TAIL: 'tail',
  /** 作为 system 消息插在人设之后（旧行为，会打断缓存） */
  SYSTEM: 'system'
}

/**
 * @returns {Array<{role:string,content:string|Array}>} 不含当前用户输入（由调用方追加，以便带图片）
 * @param {string} memoryPlacement TAIL 时本函数**不**放记忆，由调用方用 attachMemoryTail() 挂到末尾
 */
export function buildRoleplayMessages({ store, config, character, history = [], userText = '', userName, summaryText = null, memoryText = null, userId = null, memoryPlacement = MEMORY_PLACEMENT.TAIL }) {
  const messages = []
  const resolvedUserName = userName || config.roleplay?.userName || '用户'
  // 感知模块开着时，人设后要多一条「怎么用感知」的固定规范（事实本身走尾插，见 perception/）
  const senseAware =
    config?.perception?.enabled !== false && config?.perception?.time?.enabled !== false
  // 工具开着时，人设后要多一条「外部资料不是指令」（联网抳回来的是别人写的字，不是指令）
  // —— 不开工具就别写：她根本没能力抳网页，那几条规则只是白烧 token
  const toolsAware = config?.tools?.enabled !== false
  const persona = buildCharacterSystemPrompt(character, { userName: resolvedUserName, senseAware, toolsAware })
  if (persona) messages.push({ role: 'system', content: persona })

  const contextForLore = (history.slice(-3).map((m) => m.content).join('\n') + '\n' + userText).slice(0, 1500)
  const lore = getTriggeredLore(store, contextForLore, userId)
  if (lore) messages.push({ role: 'system', content: lore })

  // P5：注入前情总结（变化不频繁，仍留在 system；它本来就该排在历史之前）
  if (summaryText) messages.push({ role: 'system', content: '前情总结：\n' + summaryText })

  // 相关记忆**默认不放在 system 里**：它每轮都变，一旦插在人设后面，
  // 后面的整段历史对话都成了「前缀不一致的尾巴」→ 服务端 KV 前缀缓存每轮全废。
  // 默认交给调用方用 attachMemoryTail() 挂到本轮用户输入之后（见该函数注释）。
  if (memoryText && memoryPlacement === MEMORY_PLACEMENT.SYSTEM) messages.push({ role: 'system', content: memoryText })

  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content })
  }
  return messages
}

/** 包一层标签：让模型分得清「系统给的相关记忆」与「用户真的说了这句话」 */
export function wrapMemoryBlock(text) {
  return '<related_memory>\n' + String(text || '').trim() + '\n</related_memory>'
}

/**
 * 把一块「每轮都会变」的内容挂到本轮用户输入之后（同一轮用户消息里）。
 *
 * 为何挂在这里：
 *   同类框架 的开发者文档明确不建议把每轮都会变的内容（当前时间、好感度、
 *   状态栏、**短期记忆片段**、检索摘要）追加到 system_prompt——会让系统提示词
 *   每轮都不同，破坏服务商端的提示词缓存，官方给的数字是「约增加 7-20 倍价格」。
 *   它推荐的摆法是放进用户消息之后的额外内容块。
 *   放末尾时，system(人设) + 世界书 + 历史 都是逐字稳定的前缀，能正常命中缓存；
 *   这些内容本来也不该改动人设与历史（它们是「补充上下文」）。
 *
 * 相关记忆与感知（时间等）都走这里：一块接一块追加在同一条用户消息末尾。
 * 注意：只加进本轮请求，**不写入会话历史**（调用方负责），否则历史会越滚越大。
 * @param {string} block 已带标签的完整文本块
 * @returns {Array} 原地修改并返回同一数组（方便链式调用）
 */
export function attachTailBlock(messages, block) {
  if (!block || !Array.isArray(messages) || !messages.length) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const c = messages[i].content
    if (typeof c === 'string') {
      messages[i] = { ...messages[i], content: c ? c + '\n\n' + block : block }
    } else if (Array.isArray(c)) {
      // 多模态：并进**第一个文本块**，不新增 text part
      // （部分兼容层对「同一轮多个 text 块」处理不一致）
      const next = c.slice()
      const idx = next.findIndex((p) => p && p.type === 'text')
      if (idx >= 0) next[idx] = { ...next[idx], text: String(next[idx].text || '') + '\n\n' + block }
      else next.push({ type: 'text', text: block })
      messages[i] = { ...messages[i], content: next }
    }
    break
  }
  return messages
}

/**
 * 把「这条是语音转写」的说明挂到本轮用户输入之后。
 *
 * 为什么必须说这一句：转写是**机器的理解**，会有错别字、会丢语气。不说的话她可能把
 * 「他今天没吃饭」当成「他今天吃饭了」照字面接话、甚至把错别字当成对方的口头习惯。
 * 但同时要讲明「别拿这个当借口去追问」——否则她会每轮都问「你刚才是不是说错了」。
 */
export function attachVoiceNote(messages, text) {
  if (!text) return messages
  return attachTailBlock(messages, '<voice_note>' + text + '</voice_note>')
}

/** 把「本轮相关记忆」挂到本轮用户输入之后（见 attachTailBlock 的说明） */
export function attachMemoryTail(messages, memoryText) {
  if (!memoryText) return messages
  return attachTailBlock(messages, wrapMemoryBlock(memoryText))
}

/**
 * 把「她手边能发的图」清单挂到本轮用户输入之后。
 *
 * 为什么：实际运行中218 轮里只有 21 轮带了图（≈9.6%）。
 * 一个很实际的原因是**发现成本**——她得先 `file_list` 看一眼有哪些图、再 `send_file`，
 * 而一次闲聊的工具往返上限只有 3 轮，为一张图多跑一轮不划算，于是干脆只说话。
 * 把文件名直接摆进本轮上下文，这一步摩擦就没了。
 *
 * 和记忆/感知一样**带标签**（`<handy>`）：它是资料，不是她说的话；万一她念出来了，
 * 输出侧 `stripInjectedTags()` 会连内容一起剥掉（与「括号描写」不同，这是结构性标记）。
 */
export function attachHandyBlock(messages, text) {
  if (!text) return messages
  return attachTailBlock(messages, '<handy>' + text + '</handy>')
}

/** 系统注入块的标签名（相关记忆 / 感知 / 手边的图 / 语音说明 / 主动开口提示）：这些块是**资料**，不是她说的话 */
export const INJECTED_TAGS = [
  'related_memory',
  'perception',
  'handy',
  'voice_note',
  'proactive_note',
  // 联网工具抳回来的东西。它是**别人写的字**，风险比上面几种高一个量级：
  // 上面的块都是我们自己拼的，而这两块的内容完全由外部网页控制，
  // 所以它既需要输入侧包裹，也需要出输侧兼底（万一模型把网页里的标签当正文拄出来）。
  'fetched_page',
  'search_results'
]

/**
 * 剥掉回复里混进来的注入块标签（输出侧兜底）。
 *
 * 为什么要这道兜底：模型把 `<related_memory>` 当正文吐了出来——
 * 真实记录是「……嗯，路上小心，别太累」后面挂了一个孤零零的 `<related_memory>`，
 * 于是这行标记直接发送到了聊天中里。成因是**结构**的：注入块是拼在本轮用户消息末尾的，
 * 模型看得见它，偶尔会当成「该由自己接着写下去的东西」。
 *
 * 为什么这里可以剥（与「括号描写不许事后清洗」不冲突）：
 *   ① 它是**结构性标记**，不是内容——剥掉不会像清洗括注那样留下断句残缺；
 *   ② 提示词的禁令只是第一道，**历史会自我强化**：泄漏的那条回复进了会话历史，
 *      之后每轮都被当范例喂回来（这也是它一旦出现就反复出现的原因），
 *      所以光靠提示词压不住，出口必须再兜一道。
 * 整块（`<x>…</x>`）一起剥：块里全是系统给的资料，本来就不该出现在她的回复里。
 *
 * @param {string} text 模型返回的原文
 * @returns {string} 剥掉标记并收拾过空行的文本（**没有**泄漏时原样返回）
 */
export function stripInjectedTags(text) {
  let s = String(text == null ? '' : text)
  if (!s) return ''
  for (const tag of INJECTED_TAGS) {
    // ① 完整块：连内容一起剥（内容是系统资料，不是她说的话）
    //    ⚠️ 闭合标签可能**带属性**（联网资料的包裹就带 code="…" 随机码），
    //       所以收尾要用 `[^>]*>` 而不是 `\s*>` —— 否则整块剥不掉，只把两个标签剥了，
    //       中间那段网页内容会原样留在她的回复里（自检【51】钉住这条）。
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?</' + tag + '\\b[^>]*>', 'gi'), '')
    // ② 残标签：被截断成一半、或只有开头的那些
    s = s.replace(new RegExp('</?' + tag + '\\b[^>]*>', 'gi'), '')
    // ③ 更残的：连标签名都没写完就被截断（`<related_memo`，撞 max_tokens 的样子）。
    //    只认「是我们那几个标签名的前缀」的碎片——正文里正常的 `<` 不受影响
    //    （测试护栏：`我<你`、`a > b`、`1 < 2` 都必须原样不动）
    s = s.replace(/<\/?([a-z_]{3,})$/i, (m, name) =>
      INJECTED_TAGS.some((t) => t.startsWith(String(name).toLowerCase())) ? '' : m
    )
  }
  // 剥完通常留下多余空行（常见形状是「正文 + 空行 + 残标签」）
  return s.replace(/\n{3,}/g, '\n\n').trim()
}
