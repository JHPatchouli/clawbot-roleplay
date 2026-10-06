/**
 * 用量计（内存环形缓冲，最近 N 轮）。
 *
 * 为什么要有它：
 *   各家都会返回 token 用量与**缓存命中 token 数**，但我们此前把它丢掉了——
 *   于是「提示词摆位对不对」「缓存到底有没有命中」全是靠推理，没有数。
 *   这个审计把指标变成可观测的：每轮落一条日志，`/usage` 看滚动统计。
 *
 * 只放内存、不落盘：
 *   - 这是运行态观测量，重启清零可以接受；
 *   - 写进 store 会跟着 JsonStore 每秒的整份刷盘一起写，得不偿失。
 */

/** 一次调用的用量记录 */
function pick(u) {
  if (!u || !Number.isFinite(u.prompt)) return null
  return {
    prompt: u.prompt,
    completion: u.completion ?? 0,
    cacheHit: u.cacheHit ?? 0,
    cacheMiss: u.cacheMiss ?? null,
    hitRate: u.hitRate,
    calls: 1
  }
}

export function createUsageMeter({ size = 100 } = {}) {
  const ring = []
  const totals = { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, withCache: 0, rounds: 0 }

  /** 一轮对话可能有多条调用（工具往返），所以一次 record 传一个数组 */
  function record(list, meta = {}) {
    const rows = (Array.isArray(list) ? list : [list]).map(pick).filter(Boolean)
    if (!rows.length) return null
    const sum = {
      calls: 0,
      prompt: 0,
      completion: 0,
      cacheHit: 0,
      cacheMiss: 0,
      // 有的厂商（如 DeepSeek 首次调用）会给出缓存字段但命中为 0，也要计入分母
      hasCache: rows.some((r) => r.hitRate != null),
      at: Date.now(),
      rounds: meta.rounds ?? null,
      tools: meta.tools ?? null
    }
    for (const r of rows) {
      sum.calls += 1
      sum.prompt += r.prompt
      sum.completion += r.completion
      sum.cacheHit += r.cacheHit
      sum.cacheMiss += r.cacheMiss ?? 0
    }
    ring.push(sum)
    if (ring.length > size) ring.shift()

    totals.calls += sum.calls
    totals.prompt += sum.prompt
    totals.completion += sum.completion
    totals.cacheHit += sum.cacheHit
    totals.cacheMiss += sum.cacheMiss
    if (sum.hasCache) totals.withCache += 1
    totals.rounds += 1
    return sum
  }

  function stats() {
    const r = { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, rounds: 0, cached: 0 }
    for (const x of ring) {
      r.calls += x.calls
      r.prompt += x.prompt
      r.completion += x.completion
      r.cacheHit += x.cacheHit
      r.cacheMiss += x.cacheMiss
      r.rounds += 1
      if (x.hasCache) r.cached += 1
    }
    return {
      window: r,
      totals,
      hitRate: r.prompt ? r.cacheHit / r.prompt : null,
      texts: {
        window: r.rounds ? r.rounds + ' 轮' : '无',
        calls: r.calls
      }
    }
  }

  function clear() {
    ring.length = 0
    for (const k of Object.keys(totals)) totals[k] = 0
  }

  return { record, stats, clear, size }
}
