import { createHash } from 'node:crypto'

/**
 * 会话历史（只存「聊天」轮次），按会话隔离。
 *
 * ⚠️ 设计约束：命令流量（/xxx、菜单数字选择、向导输入）绝不写入这里，
 * 避免命令上下文污染角色扮演逻辑与记忆抽取。
 *
 * key 结构：chat:<userId>:<sessionId>
 *
 * ⚠️ 关于「只保留最后 MAX_TURNS 条」：这一层的**长度是恒定的**，
 * 所以任何「用 list().length 当进度水位线」的写法在窗口满之后都会**永久卡死**
 * 。
 * 要记进度就用 messageFingerprint()，不要用长度或下标。
 */
const MAX_TURNS = 40

/**
 * 追加消息时的**单调序号**种子。
 * `Math.max(Date.now(), lastSeq + 1)` ⇒ 同一毫秒内连续追加也不会撞；
 * 进程重启后 lastSeq 归零，但 Date.now() 必然大于历史值，所以仍然单调 ✓
 */
let lastSeq = 0

/**
 * 一条消息的**指纹**（优先用写入时给的单调序号，旧的/导入的消息退回「时间 + 正文哈希」）。
 *
 * 用途只有一个：回答「这条是不是已经处理过的那条」（记忆抽取的水位线，见 router.js）。
 * 为什么不用下标/数组长度：历史是 40 条滑窗，**下标会漂**，窗口满后长度更是恒定不变。
 * 为什么要 `seq` 而不只用「时间 + 哈希」：同一个毫秒内追加两条一模一样的短话
 * （自检里真出现过：假模型两次都回「……嗯。」）指纹会撞，水位线就看不出前进了。
 */
export function messageFingerprint(m) {
  const seq = Number(m && m.seq)
  if (Number.isFinite(seq) && seq > 0) return 'q' + seq
  const text = String((m && (m.content ?? m.text)) || '')
  return 'a' + Number((m && m.at) || 0) + ':' + createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** 从后往前找指纹相同的那条，返回下标；找不到返回 -1 */
export function lastIndexMatching(list, fp) {
  for (let i = list.length - 1; i >= 0; i--) if (messageFingerprint(list[i]) === fp) return i
  return -1
}

function key(uid, sid) {
  return 'chat:' + uid + ':' + (sid || 'default')
}

/**
 * 一条消息的**可信**发生时间（毫秒）；拿不到就返回 null。
 *
 * 「可信」的界线在这里：`append` 写的是收到消息那一刻，是真的；
 * 而导入历史时源文件里没有时间，只能拿导入时刻把 `at` 填上，
 * 那**不是**这条消息发生的时间——这种消息会被标 `atUnknown`，这里就不认。
 * 宁可不给时间，也不能拿导入时刻冒充发生时刻（否则记忆会集体装成“今天发生的”）。
 */
export function messageTime(m) {
  if (!m || m.atUnknown) return null
  const t = Number(m.at)
  return Number.isFinite(t) && t > 0 ? t : null
}

/** 时间前缀：`[19:37] `；没有可信时间就什么都不加 */
function timeTag(ms) {
  const p = (n) => String(n).padStart(2, '0')
  const d = new Date(ms)
  return '[' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] '
}

/**
 * 把消息拼成「抽取器要看的」对话文本。
 *
 * 为什么要带时间：不带的话抽取器根本看不到时间，只能靠正文猜——
 * 曾经生成过「凌晨一点多」这种无从核实的时间。带上之后，“昨天/下周”
 * 这类相对说法才有锚点可换算（照 同类框架 的「时间转换」规矩）。
 * 时间不可信的消息**不加前缀**，免得它把导入时刻当成发生时间。
 * @returns {{ text: string, from: number|null, to: number|null }}
 */
export function toExtractText(messages, { maxChars = 0 } = {}) {
  let list = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.content ?? m.text ?? '').trim())
  // 超长时按**消息**粒度裁尾，而不是直接切字符串：
  // 直接切会把 `[19:37] ` 前缀切掉一半、或留下半句话，
  // 抽取器会把残缺内容当成完整事实。
  if (maxChars > 0) {
    let total = 0
    let start = list.length
    for (let i = list.length - 1; i >= 0; i--) {
      const cost = String(list[i].content ?? list[i].text ?? '').length + 40
      if (total + cost > maxChars && start < list.length) break
      total += cost
      start = i
    }
    list = list.slice(start)
  }
  const lines = []
  let from = null
  let to = null
  for (const m of list) {
    const content = String(m.content ?? m.text ?? '').trim()
    const ms = messageTime(m)
    if (ms != null) {
      if (from == null || ms < from) from = ms
      if (to == null || ms > to) to = ms
    }
    lines.push((ms == null ? '' : timeTag(ms)) + (m.role === 'assistant' ? 'assistant' : 'user') + '：' + content)
  }
  return { text: lines.join('\n'), from, to }
}

export function createHistory(store) {
  const read = (uid, sid) => {    const h = store.get(key(uid, sid), [])
    return Array.isArray(h) ? h : []
  }
  const write = (uid, sid, h) => store.set(key(uid, sid), h)

  return {
    list(uid, sid) {
      return read(uid, sid)
    },
    messages(uid, sid) {
      return read(uid, sid).map((m) => ({ role: m.role, content: m.content }))
    },
    /** 追加一条聊天轮次；extra 可附加 reasoning（思考链）/ tools（工具调用轨迹）等元数据 */
    append(uid, sid, role, content, extra) {
      const h = read(uid, sid)
      const now = Date.now()
      // seq：**单调递增**（同一毫秒内也不会撞），供 messageFingerprint 当身份用。
      // 不另写一次 store（JsonStore 每次 set 都要整份刷盘）：直接挂在消息自己身上。
      lastSeq = Math.max(now, lastSeq + 1)
      const item = { role, content, at: now, seq: lastSeq }
      if (extra && typeof extra === 'object') Object.assign(item, extra)
      h.push(item)
      while (h.length > MAX_TURNS) h.shift()
      write(uid, sid, h)
      return h
    },
    pop(uid, sid) {
      const h = read(uid, sid)
      h.pop()
      write(uid, sid, h)
      return h
    },
    /** 整体替换（导入会话用，不做条数裁剪） */
    set(uid, sid, messages) {
      write(
        uid,
        sid,
        (messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          at: m.at || Date.now(),
          // 导入的来源没带时间时要留下记号：`at` 被填成了导入时刻，
          // 但它**不是**这条消息发生的时间（见 messageTime 的注释）
          ...(m.atUnknown ? { atUnknown: true } : {}),
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          ...(Array.isArray(m.tools) && m.tools.length ? { tools: m.tools } : {})
        }))
      )
    },
    clear(uid, sid) {
      store.remove(key(uid, sid))
    },
    size(uid, sid) {
      return read(uid, sid).length
    }
  }
}
