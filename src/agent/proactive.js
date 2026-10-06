/**
 * 主动消息的调度器：**随机时间由角色先发送消息**。
 *
 * 为什么单独一个模块：这是唯一一条「没有人跟她说话」的发起路径，风险集中在三件事上——
 * 打扰过头、把正常回复搞挂、事后关不掉。所以设计上是三条硬约束：
 *
 *  ① **默认关**（`config.proactive.enabled`），`/proactive off` 可在线关掉，关掉即不再排定时器；
 *  ② 能不能开口是**纯函数**决定的（静默时段 / 每日上限 / 距上次说话够久 / 随机间隔范围），
 *     条件判断是纯函数，测试可以直接断言；
 *  ③ 定时器 `unref()`（不阻止进程退出）、整轮包 try（出错只记日志）——
 *     **绝不允许影响正常回复链路**。
 *
 * 真正「说话」交给 `router.initiateTurn()`：那条路与正常一轮完全一样（人设 / 世界书 / 历史 /
 * 相关记忆 / 感知时间 / 工具），所以 token 消耗、限流、失败回落待发队列全都一致。
 */

const DEFAULT_TZ = 'Asia/Shanghai'

/** 本地时区的「今天是几号」（YYYY-MM-DD）；每日上限按**本地日历日**算，不用 UTC 日 */
function dayInTz(ms, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(ms))
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || ''
    return get('year') + '-' + get('month') + '-' + get('day')
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/** 本地时区的小时（0~23）*/
function hourInTz(ms, tz) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms))
        .find((p) => p.type === 'hour').value
    )
  } catch (_) {
    return new Date(ms).getHours()
  }
}

/** 短 uid（日志用） */
const short = (u) => String(u || '').slice(0, 10) + '…'

export function createProactive({
  config,
  store,
  logger,
  fire,
  listUsers,
  lastActivityAt,
  now = () => Date.now(),
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timer = null
  let stopped = true
  const log = logger || { info() {}, warn() {} }

  const cfg = () => config.proactive || {}
  const tz = () => cfg().timeZone || DEFAULT_TZ
  const readState = (k, d) => {
    try {
      return store.get(k, d)
    } catch (_) {
      return d
    }
  }
  const writeState = (k, v) => {
    try {
      store.set(k, v)
    } catch (_) {}
  }

  /** 现在是不是「不该打扰」的时段（跨零点也要对，比如 23~9） */
  function inQuietHours(ms) {
    const from = Number(cfg().quietFromHour ?? 23)
    const to = Number(cfg().quietToHour ?? 9)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false
    const h = hourInTz(ms, tz())
    return from < to ? h >= from && h < to : h >= from || h < to
  }

  /** 今天已经主动说了几次 */
  function firedToday(userId, ms) {
    const st = readState('proactive:fired:' + userId, null)
    if (!st || st.day !== dayInTz(ms, tz())) return 0
    return Number(st.n) || 0
  }

  /**
   * 随机间隔（毫秒）：落在 [minGapMinutes, maxGapMinutes] 内。
   *
   * ⚠️ 单位当年就抛过：原来写成 `Math.max(lo, Number(maxGapMinutes)) * 60000`，
   * 而 `lo` 已经是**毫秒**、`maxGapMinutes` 是**分钟** —— 两者相较永远选 `lo`，
   * 结果上限被算成 `lo × 60000`（当时的参数下是 20 分钟 → 7.2e10 毫秒 ≈ 两年），
   * 「首次检查」几乎永远排不到，看上去就像功能没生效。
   * 先全部用分钟计算，最后只换算一次。
   */
  function nextDelayMs(users = null) {
    const loMin = Math.max(1, Math.min(720, Number(cfg().minGapMinutes ?? 60)))
    const hiMin = Math.max(loMin, Math.min(720, Number(cfg().maxGapMinutes ?? 240)))
    // 夹到 [0,1]：Math.random() 本来就 <1，注入的 random 若给 1 要能取到**上限**（自检钉住了这条）
    const r = Math.min(1, Math.max(0, Number(random()) || 0))
    let delay = Math.round((loMin + r * (hiMin - loMin)) * 60000)
    // 「过 N 分钟再找我」要真的按时到：若有人预约了且比随机间隔更早，就按那个时间叫醒自己
    const ms = now()
    for (const uid of users || (listUsers ? listUsers() : []) || []) {
      const at = Number(readState('proactive:at:' + uid, 0)) || 0
      if (at > ms && at - ms < delay) delay = at - ms
    }
    return delay
  }

  /**
   * 现在能不能对她开口（**纯函数**，便于自检）。
   * @returns {null|string} null = 可以发；字符串 = 不能发的原因
   */
  function blockReason(userId, ms) {
    const c = cfg()
    if (!c.enabled) return '未开启'
    // 用户手动关过（`/proactive off`）→ 她自己不能翻回来，否则「回滚闸门」就形同虚设
    if (c.lockedByUser) return '他让我先安静一会儿（要恢复得他开口）'
    if (inQuietHours(ms)) return '静默时段'
    const cap = Number(c.maxPerDay ?? 0)
    if (cap > 0 && firedToday(userId, ms) >= cap) return '今天已经主动说过 ' + cap + ' 次了'
    const override = Number(readState('proactive:at:' + userId, 0)) || 0
    if (override && ms < override) {
      return '约好了再等 ' + Math.max(1, Math.round((override - ms) / 60000)) + ' 分钟'
    }
    const last = Number(lastActivityAt ? lastActivityAt(userId) : 0) || 0
    const silenceMs = Number(c.minSilenceMinutes ?? 30) * 60000
    if (last && ms - last < silenceMs) {
      return '刚刚才聊过（' + Math.round((ms - last) / 60000) + ' 分钟前）'
    }
    return null
  }

  /**
   * 她（模型）能改的那几项设置，**全部在这里夹取**——安全边界写在代码里，
   * 不靠提示词（提示词只是「告诉她范围」，越界必须被代码挡回去）。
   *
   * 为什么这样定范围：
   *   · 间隔 ≥10 分钟：再密就是骚扰了；上限 720（12 小时）让她能说「今天晚点再找你」
   *   · 每天 ≤6 次：防止她一口气把额度刷完
   *   · 静默时段**必须覆盖凌晨 1~6 点**：可以放宽到 20 点~10 点，但不许把半夜变成可打扰时段
   *   · 只能「暂停」不能「恢复」：用户 `/proactive off` 之后她不许自己翻回来（回滚闸门要有意义）
   *   · 「过 N 分钟再找我」同样夹在 10~720 分钟内
   * @returns {{ok:boolean, changed:object, clamped:string[], settings:object, reason?:string}}
   */
  function applySettings(userId, patch = {}) {
    const c = cfg()
    const clamped = []
    const next = {}
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    const clampPair = (lo0, hi0) => {
      let lo = Math.max(10, Math.min(720, lo0))
      let hi = Math.max(10, Math.min(720, hi0))
      if (lo !== lo0) clamped.push('间隔下限夹到 ' + lo + ' 分钟')
      if (hi !== hi0) clamped.push('间隔上限夹到 ' + hi + ' 分钟')
      if (hi < lo) {
        hi = lo
        clamped.push('上限比下限小，已抬到下限')
      }
      return [lo, hi]
    }

    if (patch.gapMin !== undefined || patch.gapMax !== undefined) {
      const lo0 = num(patch.gapMin) ?? Number(c.minGapMinutes ?? 60)
      const hi0 = num(patch.gapMax) ?? Number(c.maxGapMinutes ?? 240)
      const [lo, hi] = clampPair(lo0, hi0)
      next.minGapMinutes = lo
      next.maxGapMinutes = hi
    }
    if (patch.silenceMinutes !== undefined) {
      const v = num(patch.silenceMinutes)
      if (v !== null) {
        const cl = Math.max(10, Math.min(1440, v))
        if (cl !== v) clamped.push('静默时长夹到 ' + cl + ' 分钟')
        next.minSilenceMinutes = cl
      }
    }
    if (patch.maxPerDay !== undefined) {
      const v = num(patch.maxPerDay)
      if (v !== null) {
        const cl = Math.max(1, Math.min(6, Math.round(v)))
        if (cl !== v) clamped.push('每天上限夹到 ' + cl + ' 次')
        next.maxPerDay = cl
      }
    }
    if (patch.quietFrom !== undefined || patch.quietTo !== undefined) {
      let from = num(patch.quietFrom) ?? Number(c.quietFromHour ?? 23)
      let to = num(patch.quietTo) ?? Number(c.quietToHour ?? 9)
      from = Math.max(20, Math.min(23, Math.round(from)))
      to = Math.max(6, Math.min(10, Math.round(to)))
      if (from !== num(patch.quietFrom) && patch.quietFrom !== undefined) clamped.push('静默时段起点夹到 ' + from + ' 点')
      if (to !== num(patch.quietTo) && patch.quietTo !== undefined) clamped.push('静默时段终点夹到 ' + to + ' 点')
      next.quietFromHour = from
      next.quietToHour = to
    }
    if (patch.pause === true) next.enabled = false
    if (patch.resume === true) {
      if (c.lockedByUser) {
        return { ok: false, reason: '他刚才让我先安静一会儿，要重新开始得他开口（不能自己翻回来）', changed: {}, clamped, settings: settingsView() }
      }
      next.enabled = true
    }
    if (patch.inMinutes !== undefined) {
      const v = num(patch.inMinutes)
      if (v !== null) {
        const cl = Math.max(10, Math.min(720, Math.round(v)))
        if (cl !== v) clamped.push('「过 N 分钟再找我」夹到 ' + cl + ' 分钟')
        try {
          store.set('proactive:at:' + userId, now() + cl * 60000)
        } catch (_) {}
      }
    }
    if (Object.keys(next).length) {
      try {
        config.proactive = { ...(c || {}), ...next }
      } catch (_) {}
    }
    const changed = { ...next }
    if (patch.inMinutes !== undefined) changed.nextInMinutes = Math.max(10, Math.min(720, Math.round(num(patch.inMinutes) || 0)))
    log.info('[proactive] 她改了设置：' + JSON.stringify(changed) + (clamped.length ? '（夹取：' + clamped.join('；') + '）' : ''))
    return { ok: true, changed, clamped, settings: settingsView() }
  }

  /** 当前设置（给她/给命令看的一份干净快照）*/
  function settingsView() {
    const c = cfg()
    return {
      enabled: !!c.enabled,
      lockedByUser: !!c.lockedByUser,
      minGapMinutes: Number(c.minGapMinutes ?? 60),
      maxGapMinutes: Number(c.maxGapMinutes ?? 240),
      minSilenceMinutes: Number(c.minSilenceMinutes ?? 30),
      maxPerDay: Number(c.maxPerDay ?? 0),
      quietFromHour: Number(c.quietFromHour ?? 23),
      quietToHour: Number(c.quietToHour ?? 9)
    }
  }


  async function tick() {
    timer = null
    if (stopped) return
    try {
      const ms = now()
      const users = (listUsers ? listUsers() : []) || []
      if (!cfg().enabled) {
        log.info('[proactive] 未开启，跳过本次（下次仍会检查）')
      } else {
        for (const uid of users) {
          const why = blockReason(uid, ms)
          if (why) {
            log.info('[proactive] 跳过 ' + short(uid) + '：' + why)
            continue
          }
          const r = await fire(uid).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }))
          if (r && r.ok) {
            writeState('proactive:fired:' + uid, {
              day: dayInTz(ms, tz()),
              n: firedToday(uid, ms) + 1,
              at: ms
            })
            // 预约是一次性的：用过就清，否则会一直卡着下次的随机间隔
            try {
              store.remove('proactive:at:' + uid)
            } catch (_) {}
            log.info('[proactive] 主动消息了：' + short(uid) + '（今天第 ' + (firedToday(uid, ms) + 1) + ' 次）')
          } else {
            log.warn('[proactive] 主动开口没成功：' + ((r && r.reason) || '未知'))
          }
          break // 一次 tick 最多让一个人开口，避免几路模型调用挤在一起
        }
      }
    } catch (e) {
      log.warn('[proactive] 调度出错（不影响正常回复）：' + e.message)
    } finally {
      schedule(nextDelayMs())
    }
  }

  function schedule(delayMs) {
    if (stopped) return
    if (timer) clearTimer(timer)
    // unref：定时器不该阻止进程退出（容器里 SIGTERM 后要能干净退出）
    timer = setTimer(() => {
      void tick()
    }, delayMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      const d = nextDelayMs()
      schedule(d)
      log.info(
        '[proactive] 调度已启动：间隔 ' +
          Math.round(d / 60000) +
          ' 分钟后首次检查（随机范围 ' +
          Number(cfg().minGapMinutes ?? 60) +
          '~' +
          Number(cfg().maxGapMinutes ?? 240) +
          ' 分钟；每天最多 ' +
          Number(cfg().maxPerDay ?? 0) +
          ' 次；静默时段 ' +
          Number(cfg().quietFromHour ?? 23) +
          ' 点到 ' +
          Number(cfg().quietToHour ?? 9) +
          ' 点）'
      )
    },
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      log.info('[proactive] 调度已停止')
    },
    running() {
      return !stopped
    },
    /** 立刻让她开口一次（`/proactive now` 用；忽略静默时段，但**不**忽略开关） */
    async fireNow(userId) {
      if (!cfg().enabled) return { ok: false, reason: '未开启（先 /proactive on）' }
      const r = await fire(userId).catch((e) => ({ ok: false, reason: (e && e.message) || String(e) }))
      if (r && r.ok) {
        const ms = now()
        writeState('proactive:fired:' + userId, {
          day: dayInTz(ms, tz()),
          n: firedToday(userId, ms) + 1,
          at: ms
        })
        try {
          store.remove('proactive:at:' + userId)
        } catch (_) {}
      }
      return r
    },
    /** 她（模型）改设置：安全范围在 applySettings 里夹取 */
    applySettings,
    settingsView,
    /** 给 `/proactive` 状态用 */
    status() {
      const ms = now()
      const users = (listUsers ? listUsers() : []) || []
      return {
        enabled: !!cfg().enabled,
        running: !stopped,
        minGapMinutes: Number(cfg().minGapMinutes ?? 60),
        maxGapMinutes: Number(cfg().maxGapMinutes ?? 240),
        minSilenceMinutes: Number(cfg().minSilenceMinutes ?? 30),
        maxPerDay: Number(cfg().maxPerDay ?? 0),
        quietFromHour: Number(cfg().quietFromHour ?? 23),
        quietToHour: Number(cfg().quietToHour ?? 9),
        quietNow: inQuietHours(ms),
        nextDelayMinutes: Math.round(nextDelayMs() / 60000),
        users: users.map((u) => {
          const last = Number(lastActivityAt ? lastActivityAt(u) : 0) || 0
          return {
            userId: u,
            firedToday: firedToday(u, ms),
            silentMinutes: last ? Math.round((ms - last) / 60000) : null,
            blockReason: blockReason(u, ms)
          }
        })
      }
    },
    // 自检用（纯函数，不碰定时器）
    _blockReason: blockReason,
    _nextDelayMs: nextDelayMs,
    _applySettings: applySettings,
    _dayInTz: (ms) => dayInTz(ms, tz()),
    _hourInTz: (ms) => hourInTz(ms, tz())
  }
}
