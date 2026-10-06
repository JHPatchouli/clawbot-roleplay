/**
 * 自适应发送限流（AIMD：加法增、乘法减）。
 *
 * 背景：
 *   iLink 需要主动限流。一次回复连发到
 *   第 10~11 条时必现 `ret=-2 prepare failed`，且**一旦触发，随后数秒内连单条
 *   消息也发不出去**（窗口内已有 6 条 → 等待 9.4s → 再发仍然 -2）。
 *   因此固定间隔解决不了问题：
 *     - 间隔太小 → 触发限流，整段回复丢失
 *     - 间隔太大 → 正常场景下用户要等很久
 *   改为让限流器自己学习当前账号的容忍度。
 *
 * 算法：
 *   窗口 `windowMs` 内最多发 `quota` 条（quota 初始 = maxPerWindow）
 *   - 连续成功 `probeAfter` 次 → quota +1（上限 maxPerWindow），试探更高吞吐
 *   - 命中 ret=-2         → quota 减半（下限 minPerWindow），并进入冷却
 *                             cooldown = baseCooldown * 2^(连续命中次数-1)，上限 maxCooldown
 *   冷却期内的请求一律排队等待，避免「撞墙式重试」把冷却越拖越长。
 *
 * 说明：quota 与冷却时间只在进程内生效（重启回到初始值），
 * 这是刻意的——重启后账号侧的限制通常已经恢复，不需要继承悲观状态。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createSendLimiter({
  windowMs = 15000,
  maxPerWindow = 6,
  minPerWindow = 1,
  baseCooldownMs = 4000,
  maxCooldownMs = 60000,
  probeAfter = 3,
  logger = null
} = {}) {
  let quota = Math.max(minPerWindow, maxPerWindow)
  let successes = 0
  let strikes = 0
  let cooldownUntil = 0
  let times = []

  function prune(now) {
    while (times.length && now - times[0] >= windowMs) times.shift()
  }

  return {
    get quota() {
      return quota
    },
    get cooldownRemaining() {
      return Math.max(0, cooldownUntil - Date.now())
    },
    /** 本窗口内已占用额度 */
    get used() {
      prune(Date.now())
      return times.length
    },

    /** 状态摘要（/status、/dashboard 展示） */
    stats() {
      return { quota, maxPerWindow, minPerWindow, used: this.used, cooldownMs: this.cooldownRemaining }
    },

    /**
     * 取得一次发送许可；必要时排队等待。
     * 注意：许可在「发起请求前」占用，失败也照常计入（失败同样消耗了账号侧配额）。
     */
    async acquire() {
      for (;;) {
        const now = Date.now()
        // 1) 冷却期：上次被限流后的静默等待
        if (now < cooldownUntil) {
          const wait = cooldownUntil - now
          logger?.info(`限流冷却中，等待 ${wait}ms（额度 ${quota}）`)
          await sleep(wait)
          continue
        }
        prune(now)
        if (times.length < quota) {
          times.push(Date.now())
          return
        }
        // 2) 窗口已满：等最早那条滑出窗口
        const wait = Math.max(windowMs - (now - times[0]) + 250, 250)
        logger?.info(`限速等待 ${wait}ms（${Math.round(windowMs / 1000)}s 内已发 ${times.length}/${quota} 条）`)
        await sleep(wait)
      }
    },

    /** 发送成功：缓慢加额，试探账号的真实容忍度 */
    onSuccess() {
      strikes = 0
      successes++
      if (successes >= probeAfter && quota < maxPerWindow) {
        quota++
        successes = 0
        logger?.info(`限流自适应：连续成功，额度提升至 ${quota}/${maxPerWindow}`)
      } else if (successes >= probeAfter) {
        successes = 0
      }
    },

    /** 命中 ret=-2：额度折半 + 指数冷却 */
    onThrottled() {
      strikes++
      const before = quota
      quota = Math.max(minPerWindow, Math.floor(quota / 2))
      const cd = Math.min(baseCooldownMs * 2 ** (strikes - 1), maxCooldownMs)
      cooldownUntil = Date.now() + cd
      successes = 0
      logger?.warn(`命中限流：额度 ${before} → ${quota}，冷却 ${cd}ms（连续 ${strikes} 次）`)
      return { quota, cooldownMs: cd }
    }
  }
}

/**
 * 把分段结果合并到「最多 maxSegments 条」。
 * 一次回复超过约 10 条就容易触发限流，与其在第 11 条撞墙后整段丢失，
 * 不如提前把相邻短段合并成稍长的消息（仍然保持逐行发送的观感）。
 */
export function capSegments(segments, maxSegments) {
  const segs = (segments || []).filter((s) => s !== '')
  if (!maxSegments || segs.length <= maxSegments) return segs
  // 均匀分组：把 N 段合并成 maxSegments 组，组内按原顺序拼接
  const groups = []
  const per = Math.ceil(segs.length / maxSegments)
  for (let i = 0; i < segs.length; i += per) groups.push(segs.slice(i, i + per).join('\n'))
  return groups
}
