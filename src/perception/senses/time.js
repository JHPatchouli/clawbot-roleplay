/**
 * 感知 · 时间（感知管理模块的第一个能力）
 *
 * 为什么需要这个能力：
 *   模型自己没有「现在几点、今天几号」的感知——它的时间感只到训练截止日期。
 *   但角色扮演里大量对话都建立在这上面：对方说「都十一点了还不睡」，角色接不上；
 *   问「今天星期几」只能猜。而 TRUTHFULNESS_RULE 又明确禁止它猜时间（「具体的时间或数字
 *   这类你无从知道的外部事实……不要凭想象给出具体细节」），于是它只能回避——表现为
 *   一个连今天几号都不知道的角色。
 *   更失真的一种是「隔了很久才接上话」：模型看到的上下文只是一串连续的对话，
 *   它会当成上一句的延续去接，于是「三天没说话」和「刚说完」在它眼里一模一样。
 *
 * ⚠️ 为什么坚持用 Intl + 显式时区，而不是 `new Date().getHours()`：
 *   ① **不依赖运行环境**：本部署的容器里 `TZ=Asia/Shanghai`（docker-compose 给的），
 *      所以 `getHours()` 碰巧也是对的；但换个镜像/换台机器就可能变成 UTC，
 *      角色说的“现在”会静默差 8 小时——这种错没人会去查，所以直接显式指定时区；
 *   ② 时区要**可配**（`/perc tz`）：跨时区的用户本来就不该只能用中国时间；
 *   ③ 可测：固定时间戳 + 固定时区在**任何环境**都得同一个结果（自检【44】钉住）。
 *   注意区分：容器里 `server.log` 的时间戳是 UTC，那是 logger 用 `toISOString()` 的结果，
 *   与容器的本地时区无关（不要把这两处混淆）。
 */
import { messageTime } from '../../chat/history.js'

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** 时区是否被运行时认识（`/perc tz` 收参数前必须校验，否则 Intl 会抛） */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch (_) {
    return false
  }
}

/**
 * 按指定时区拆出年月日时分与星期。
 * 时区无效时退回默认时区（宁可差 8 小时，也好过整个能力抛异常）。
 */
export function zonedParts(ms, timeZone = DEFAULT_TIME_ZONE) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return null
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE
  const raw = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  }).formatToParts(new Date(t))) {
    if (part.type !== 'literal') raw[part.type] = part.value
  }
  const pad2 = (v) => String(v).padStart(2, '0')
  // hour12:false 下部分地区数据会把午夜给成 24 点，取模归一
  const hour = Number(raw.hour) % 24
  const minute = Number(raw.minute)
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour,
    minute,
    second: Number(raw.second),
    weekday: WEEKDAY_EN[raw.weekday] ?? 0,
    date: `${raw.year}-${pad2(raw.month)}-${pad2(raw.day)}`,
    hm: `${pad2(hour)}:${pad2(minute)}`,
    mdhm: `${Number(raw.month)}-${pad2(raw.day)} ${pad2(hour)}:${pad2(minute)}`
  }
}

/** 一天里的时段词（角色会说「这么晚还没睡」，但它得先知道这是「深夜」） */
export function periodOf(hour) {
  const h = Number(hour)
  if (!Number.isFinite(h)) return ''
  if (h < 5) return '凌晨'
  if (h < 8) return '清晨'
  if (h < 11) return '早上'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 20) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

export function isWeekend(weekday) {
  return weekday === 0 || weekday === 6
}

/** `周一 22:31（深夜）`；周末会补 `（周末）`，方便「明天还要上班」这类话成立 */
export function nowText(ms, timeZone = DEFAULT_TIME_ZONE) {
  const p = zonedParts(ms, timeZone)
  if (!p) return ''
  const wd = (WEEKDAY_CN[p.weekday] || '') + (isWeekend(p.weekday) ? '（周末）' : '')
  return `${p.date} ${wd} ${p.hm}（${periodOf(p.hour)}）`
}

/**
 * 「距上次说话」的人话说法。
 *
 * 同一天报相对量+具体时刻（`3 小时前（19:31）`）——
 * 只给相对量模型会算不出「那现在是几点」；只给时刻又读不出「隔了多久」。
 * 跨天则用「昨天 / N 天前 / N 个月前」+ 具体时刻，避免「27 小时前」这种没人这么说的表述。
 * @returns {{ms:number, minutes:number, hours:number, days:number, text:string}|null}
 */
export function gapInfo(fromMs, toMs, timeZone = DEFAULT_TIME_ZONE) {
  const a = zonedParts(fromMs, timeZone)
  const b = zonedParts(toMs, timeZone)
  if (!a || !b) return null
  const ms = Math.max(0, Number(toMs) - Number(fromMs))
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(ms / 3600000)
  // 按**当地日历日**算差，而不是按 24 小时整除：
  // 23:50 说的一句，到次日 00:20 已经是「昨天」，虽然只过了 30 分钟。
  const dayDiff = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000
  )
  const sameDay = dayDiff === 0
  let text
  // 一小时以内带上具体时刻：只给「30 分钟前」而跨了天的话，模型算不出那是昨晚 23:50
  if (minutes < 2) text = `刚刚（${a.hm}）`
  else if (minutes < 60) text = `${minutes} 分钟前（${a.hm}）`
  else if (sameDay) text = `${hours} 小时前（${a.hm}）`
  else if (dayDiff === 1) text = `昨天 ${a.hm}`
  else if (dayDiff < 30) text = `${dayDiff} 天前（${a.mdhm}）`
  else text = `${Math.floor(dayDiff / 30)} 个月前（${a.mdhm}）`
  return { ms, minutes, hours, days: dayDiff, text }
}

/**
 * 隔得久时，只提醒「别接着演上文的场景」。
 *
 * ⚠️ 不要在这里再报一次间隔。上面已经有「现在」和「上次说话：昨天 18:54」，
 *   再写「已经一天」会和那一行打架：日历一跨天 `days` 就是 1，哪怕只隔了几小时。
 *   实际运行中会出现这样让角色误以为对方一整天没回。
 * ⚠️ 也不要写「隔了很久」。那是对聊天行为的判断，角色会理解成「对方晾了自己一天」。
 *   这里只管场景：店里场景不能演到第二天早上。要不要提时间，交给 system 里的规范。
 * 阈值按「一次正常聊天中断」的量级取（默认 6 小时），比这短就不提示。
 */
export function gapHint(gap, { noticeHours = 6 } = {}) {
  if (!gap) return null
  const hours = Number(gap.hours) || 0
  const longEnough = gap.days >= 1 || hours >= Math.max(1, Number(noticeHours) || 6)
  if (!longEnough) return null
  return '提示：上文那一段的场景已经过去了，按「现在」接话，不要接着演上文。'
}

/**
 * 本轮要注入的感知正文（不含 <perception> 标签，标签由感知管理模块统一加）。
 * 没有可信时间就返回 null——不许拿导入时刻冒充「上次说话」。
 *
 * 「现在」这一行**自带优先级标记**（现实时间，以此为准）：
 * 规范里虽然写了「现实时间最高优先」，但那一行的位置离模型要回的那句话最近，
 * 把优先级写在事实旁边，比只写在 system 里更不容易被上文语境的时刻盖过去。
 */
export function timeBlock({ now = Date.now(), lastSpokeAt = null, timeZone = DEFAULT_TIME_ZONE, gapNoticeHours = 6 } = {}) {
  if (!zonedParts(now, timeZone)) return null
  const lines = ['现在（现实时间，以此为准）：' + nowText(now, timeZone)]
  const gap = lastSpokeAt == null ? null : gapInfo(lastSpokeAt, now, timeZone)
  if (gap) lines.push('上次说话：' + gap.text)
  const hint = gapHint(gap, { noticeHours: gapNoticeHours })
  if (hint) lines.push(hint)
  return lines.join('\n')
}

/**
 * 会话里「上次说话」的时刻。
 *
 * 取的是**最后一条用户消息**的可信时间，而不是最后一条消息：
 * 助手可能在被限流/重启后过了很久才补发，用助手的时间会把间隔算短。
 * `messageTime` 会抛开导入历史（`atUnknown`）——那些 `at` 是导入时刻，不是发生时刻。
 */
export function lastSpokeAt(history) {
  const list = Array.isArray(history) ? history : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue
    const t = messageTime(list[i])
    if (t != null) return t
  }
  // 没有用户消息（比如只有系统写入的轮次）：退一步用最后一条有时间戳的
  for (let i = list.length - 1; i >= 0; i--) {
    const t = messageTime(list[i])
    if (t != null) return t
  }
  return null
}

/** 时间感知能力（感知管理模块的一个 sense） */
export function createTimeSense({ configStore, config, logger } = {}) {
  const cfg = () => {
    const p = (configStore?.get?.() || config || {}).perception || {}
    return p.time || {}
  }
  return {
    id: 'time',
    name: '时间',
    kind: 'input',
    desc: '当前时刻（时区可配）+ 距上次说话多久',
    enabled: () => cfg().enabled !== false,
    available: () => {
      const tz = cfg().timeZone || DEFAULT_TIME_ZONE
      return isValidTimeZone(tz) ? { ok: true } : { ok: false, reason: '时区无效：' + tz }
    },
    perceive: ({ history, now } = {}) =>
      timeBlock({
        now: now || Date.now(),
        lastSpokeAt: lastSpokeAt(history),
        timeZone: cfg().timeZone || DEFAULT_TIME_ZONE,
        gapNoticeHours: cfg().gapNoticeHours ?? 6
      })
  }
}
