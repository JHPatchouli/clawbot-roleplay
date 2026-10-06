/**
 * ClawBot 通道：长轮询收消息 + 发送消息 + 「正在输入」。
 *
 * 职责边界：只负责「通道」——消息收发、游标、重试、幂等。
 * 业务（命令/角色扮演）通过 onMessage 回调交给上层。
 */
import { apiRequest, assertBizOk, buildBaseInfo } from './http.js'
import { buildUploadMeta } from './media.js'
import { normalizeInbound, buildOutgoingText, buildOutgoingItem } from './messages.js'
import { chunkText, splitSegments } from '../util/text.js'
import { createSendLimiter, capSegments } from './limiter.js'
import { enqueuePending, readPending, writePending, pendingStats } from './pending.js'
import { safeInboundText } from '../logger.js'
import https from 'node:https'

/**
 * 用**独立连接**上传一段字节流（不共用进程里的 keep-alive 连接池）。
 *
 * 为什么不用 fetch：同一个进程里 media_type=1 连试 3 次全 500，
 * 紧接着 media_type=3 就 200；而**新起的进程**里同样 media_type=1 连试 4 次全 200。
 * 图片与文件很可能落在不同后端/不同连接上，而 app 里那一条（池里的）坏了 —— fetch 只能复用池子，
 * 换不掉。自己开 https 请求（`agent:false`）+ 短超时 + 拿全状态码/响应头/响应体，
 * 既能换新连接，也能把失败原因看仔细。
 * @returns {Promise<{status:number, headers:object, body:string, bytes:number, ms:number}>}
 */
function putBuffer(url, buf, timeoutMs, logger) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(new Error('上传地址不合法：' + url.slice(0, 60)))
      return
    }
    const t0 = Date.now()
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length },
        agent: false, // ← 关键：不复用连接池，每次都是新连接
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          if (body.length < 4096) body += c
        })
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers || {}, body, bytes: buf.length, ms: Date.now() - t0 })
        )
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('上传超时'))
    })
    req.on('error', (e) => reject(new Error('媒体上传失败：' + e.message)))
    logger?.debug?.(`媒体上传 ${u.hostname} ${buf.length}B…`)
    req.end(buf)
  })
}

const DEFAULT_LONGPOLL_MS = 35000
const CURSOR_KEY = 'channel.getUpdatesBuf'
const MAX_BACKOFF_MS = 30000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把两条入站消息并成一条。
 * 用于「图文合并窗口」：用户先发图、隔一两秒再补一句话时，
 * 应当作为**一轮**处理，而不是先答图、再答那句话。
 */
function mergeInbounds(a, b) {
  const join = (x, y) => [x, y].filter((s) => s && String(s).trim()).join('\n')
  return {
    ...a,
    text: join(a.text, b.text),
    images: [...(a.images || []), ...(b.images || [])],
    files: [...(a.files || []), ...(b.files || [])],
    voices: [...(a.voices || []), ...(b.voices || [])],
    videos: [...(a.videos || []), ...(b.videos || [])],
    // 回复要用最新一条的 contextToken
    contextToken: b.contextToken || a.contextToken
  }
}

export class Channel {
  constructor({ credentials, store, config, logger, onMessage, dataDir, putImpl }) {
    this.creds = credentials
    this.store = store
    this.config = config
    this.logger = logger
    this.onMessage = onMessage
    this.dataDir = dataDir || null
    // 媒体上传那一步的实现（默认独立 https 连接，见 putBuffer）。
    // 留成可注入是为了自检能**换掉真实网络**来测重试/超时，不至于把测试变成联网测。
    this.putImpl = putImpl || putBuffer
    this.buf = store.get(CURSOR_KEY, '')
    this.running = false
    this.failures = 0
    this.seen = new Set() // 消息幂等（进程内）
    this.stoppedReason = null
    // 用户 → 最近一次的 context_token：后台委托的结果是「几分钟后才回的话」，
    // 那时早就不在任何一轮入站里了，得靠这份记录（同时落盘，重启不丢）
    this.lastTokens = new Map()
    // 图文合并窗口：userId → { inbound, timer, deadline, count }
    // 图片到达后不立即处理，先等 mergeWindowMs，看用户会不会补一句话。
    this.mergePending = new Map()
    // 出站限流：固定间隔无法兼顾「不触发」与「不慢」，改为 AIMD 自学习
    this.limiter = createSendLimiter({
      windowMs: config.reply?.windowMs ?? 15000,
      maxPerWindow: config.reply?.maxPerWindow ?? 6,
      minPerWindow: config.reply?.minPerWindow ?? 1,
      logger
    })
    // 待发队列补发状态机：同一时刻只跑一轮补发，避免定时器与「发送成功后顺手补发」撞车
    this.draining = false
    // 定时兜底：长时间没有任何消息时也要把队列送出去。
    // unref 让它不阻止进程退出（selftest / 一次性脚本里不会把进程吊住）。
    const retryMs = Number(config.reply?.pendingRetryMs ?? 60000)
    if (retryMs > 0) {
      this.pendingTimer = setInterval(() => {
        this.drainPending().catch(() => {})
      }, retryMs)
      this.pendingTimer.unref?.()
    }
  }

  get baseUrl() {
    return this.creds.baseUrl
  }

  async start() {
    this.running = true
    // 连接起停通知失败不应阻断启动（网络抖动/接口变更均可容忍）
    try {
      await this.#notify('notifystart')
    } catch (err) {
      this.logger.warn('通知连接启动失败（忽略继续）：', err.message)
    }
    this.logger.info('ClawBot 通道已启动，开始长轮询收消息')
    // 上次停机前没发出去的内容还压在队列里 → 起来了就补发
    if (readPending(this.dataDir).length) {
      const n = readPending(this.dataDir).length
      this.logger.info(`发现 ${n} 条待发内容（上次未能送出），开始补发`)
      this.drainPending().catch(() => {})
    }
    this.loopPromise = this.#loop()
    return this.loopPromise
  }

  async stop(reason = 'manual') {
    if (!this.running) return
    this.running = false
    this.stoppedReason = reason
    // 停服时丢掉还压在合并窗口里的消息（不再回复）
    for (const p of this.mergePending.values()) clearTimeout(p.timer)
    this.mergePending.clear()
    this.logger.info('正在停止通道：', reason)
    await this.#notify('notifystop').catch(() => {})
  }

  async #notify(kind) {
    const path = `/ilink/bot/msg/${kind}`
    const resp = await apiRequest(this.baseUrl, path, {
      method: 'POST',
      body: { base_info: buildBaseInfo(this.config) },
      token: this.creds.token,
      cfg: this.config,
      timeout: 10000
    })
    return assertBizOk(resp, path)
  }

  async #loop() {
    while (this.running) {
      try {
        const resp = await this.#getUpdates()
        const timeoutMs = Number(resp?.longpolling_timeout_ms) || DEFAULT_LONGPOLL_MS
        if (resp?.get_updates_buf) {
          this.buf = resp.get_updates_buf
          this.store.set(CURSOR_KEY, this.buf) // 立即持久化游标，重启可续跑
        }
        this.failures = 0
        const msgs = Array.isArray(resp?.msgs) ? resp.msgs : []
        for (const raw of msgs) {
          await this.handleRaw(raw)
        }
        if (msgs.length === 0) await sleep(Math.min(timeoutMs, 1000))
      } catch (err) {
        if (!this.running) break
        if (err.code === 'TOKEN_INVALID') {
          this.logger.error('bot_token 已失效（errcode=-14），需要重新扫码登录。停止轮询。')
          this.running = false
          this.stoppedReason = 'token_invalid'
          this.onTokenInvalid?.()
          break
        }
        this.failures += 1
        const backoff = Math.min(2 ** this.failures * 500, MAX_BACKOFF_MS)
        this.logger.warn(`收消息失败(第 ${this.failures} 次)，${backoff}ms 后重试：`, err.message)
        await sleep(backoff)
      }
    }
  }

  async #getUpdates() {
    const path = '/ilink/bot/getupdates'
    const resp = await apiRequest(this.baseUrl, path, {
      method: 'POST',
      body: { get_updates_buf: this.buf, base_info: buildBaseInfo(this.config) },
      token: this.creds.token,
      cfg: this.config,
      timeout: 40000
    })
    return assertBizOk(resp, path)
  }

  /**
   * 处理一条原始入站消息（含图文合并窗口）。
   * 作为公开方法而非私有方法：这样 selftest 能直接喂消息验证合并时序，不用起长轮询。
   */
  async handleRaw(raw) {
    // 只处理用户消息；Bot 自身消息跳过
    if (raw?.message_type !== 1) return
    const id = raw?.message_id ?? raw?.client_id
    if (id != null) {
      if (this.seen.has(id)) return
      this.seen.add(id)
      if (this.seen.size > 2000) this.seen.clear()
    }
    const inbound = normalizeInbound(raw)
    if (inbound.userId && inbound.contextToken) {
      this.lastTokens.set(inbound.userId, inbound.contextToken)
      this.store.set('ctxToken:' + inbound.userId, inbound.contextToken)
    }
    // 含密钥的命令和粘贴的 JSON 按 logger.safeInboundText 处理后写入日志
    const kinds = [inbound.text ? 'text' : null, inbound.images?.length ? `image×${inbound.images.length}` : null, inbound.files?.length ? `file×${inbound.files.length}` : null, inbound.voices?.length ? `voice×${inbound.voices.length}` : null, inbound.videos?.length ? `video×${inbound.videos.length}` : null].filter(Boolean).join('+')
    this.logger.info(`← 收到消息 from=${inbound.userId} kind=${kinds || 'empty'} text=${safeInboundText(inbound.text)}`)
    // 文件诊断：只打印字段名
    if (inbound.files?.length) {
      for (const f of inbound.files) {
        const media = f.media || {}
        this.logger.info(
          `  文件 name=${f.file_name || '?'} len=${f.len || '?'} media 字段=[${Object.keys(media).join(',')}] full_url=${media.full_url ? '有' : '无'} aes_key=${media.aes_key ? '有' : '无'}`
        )
      }
    }
    // 图片诊断：只打印字段名，不打印 URL / key
    if (inbound.images?.length) {
      for (const img of inbound.images) {
        const media = img.media || {}
        this.logger.info(
          `  图片 media 字段=[${Object.keys(media).join(',')}] full_url=${media.full_url ? '有' : '无'} encrypt_query_param=${media.encrypt_query_param ? '有' : '无'} aes_key=${media.aes_key ? '有' : '无'} aeskey(hex)=${img.aeskey ? '有' : '无'} encrypt_type=${media.encrypt_type ?? '-'} mid_size=${img.midSize || 0}`
        )
      }
    }
    // 视频诊断：只打印字段名，不打印 URL / key
    if (inbound.videos?.length) {
      for (const v of inbound.videos) {
        const media = v.media || {}
        this.logger.info(
          `  视频 media 字段=[${Object.keys(media).join(',')}] full_url=${media.full_url ? '有' : '无'} encrypt_query_param=${media.encrypt_query_param ? '有' : '无'} aes_key=${media.aes_key ? '有' : '无'} aeskey(hex)=${v.aeskey ? '有' : '无'} encrypt_type=${media.encrypt_type ?? '-'} video_size=${v.videoSize || 0}`
        )
      }
    }
    // 语音诊断：只打印字段名，不打印 URL / key
    if (inbound.voices?.length) {
      for (const v of inbound.voices) {
        const media = v.media || {}
        this.logger.info(
          `  语音 item 字段=[${(v.itemKeys || []).join(',')}] voice_item 字段=[${(v.fields || []).join(',')}] media 字段=[${Object.keys(media).join(',')}] full_url=${media.full_url ? '有' : '无'} aes_key=${media.aes_key ? '有' : '无'} aeskey(hex)=${v.aeskey ? '有' : '无'} duration=${v.duration || 0} 自带文字=${v.text ? '有' : '无'}`
        )
      }
    }
    const hasContent =
      Boolean(inbound.text) ||
      (inbound.images?.length || 0) > 0 ||
      (inbound.files?.length || 0) > 0 ||
      (inbound.voices?.length || 0) > 0 ||
      (inbound.videos?.length || 0) > 0
    if (!hasContent) {
      // 认不出来的内容不静默丢弃：消息 item 的形状可能变化，
      // 静默失败时对方发了内容却得不到任何反馈。
      // 这里把「类型 + 字段名」记下来，并交回上层回一句话（发送方可立即看到）。
      const items = inbound.items || []
      if (items.length) {
        const info = items.map((it) => `type=${it?.type} 字段=[${Object.keys(it || {}).join(',')}]`).join(' ｜ ')
        this.logger.warn('收到无法识别的消息内容：' + info)
        try {
          await this.onMessage?.({ ...inbound, unknownItems: info })
        } catch (e) {
          this.logger.warn('回报「认不出来」时出错（忽略）：' + e.message)
        }
      }
      return
    }

    // ---- 图文合并窗口 ----
    // 聊天习惯常是「先发一张图，再补一句话」。如果图片一到就交给模型，
    // 就会先把图答了、紧接着又答那句话——所以要先把图压一会儿。
    //
    // 窗口策略：滑动 + 硬上限。
    //   每收到一条补充文本就往后顺延 windowMs，但总等待不超过 capMs
    //   （否则用户一直打字就会一直不回复）。
    const hasImage = (inbound.images || []).length > 0
    const hasOtherMedia =
      (inbound.files || []).length > 0 || (inbound.voices || []).length > 0 || (inbound.videos || []).length > 0
    const isPlainText = Boolean(inbound.text && inbound.text.trim()) && !hasImage && !hasOtherMedia
    const windowMs = Number(this.config.reply?.mergeWindowMs ?? 2500)
    const capMs = Math.max(windowMs, Number(this.config.reply?.mergeMaxWaitMs ?? 8000))

    const pending = this.mergePending.get(inbound.userId)
    if (pending) {
      if (isPlainText) {
        // 图后面补的话 → 并成一轮
        pending.inbound = mergeInbounds(pending.inbound, inbound)
        pending.count += 1
        const now = Date.now()
        const fireAt = Math.min(now + windowMs, pending.capAt)
        const left = fireAt - now
        if (left > 0) {
          clearTimeout(pending.timer)
          pending.fireAt = fireAt
          pending.timer = setTimeout(() => this.#flushPending(inbound.userId), left)
          this.logger.info(`[merge] 已并入后续文本，共 ${pending.count} 条，${left}ms 后再处理`)
          return
        }
        this.logger.info(`[merge] 已达总等待上限，立即处理 ${pending.count} 条`)
        await this.#flushPending(inbound.userId)
        return
      }
      // 其它类型（文件/视频/命令）不并入对话，先把待处理的发出去，避免串味
      await this.#flushPending(inbound.userId)
    }

    if (hasImage) {
      if (!(windowMs > 0)) {
        await this.#dispatchInbound(inbound)
        return
      }
      const now = Date.now()
      const timer = setTimeout(() => this.#flushPending(inbound.userId), windowMs)
      this.mergePending.set(inbound.userId, {
        inbound,
        timer,
        count: 1,
        capAt: now + capMs,
        fireAt: now + windowMs
      })
      this.logger.info(`[merge] 图片到达，先等 ${windowMs}ms 看是否有后续文本（总上限 ${capMs}ms）…`)
      return
    }

    await this.#dispatchInbound(inbound)
  }

  /** 合并窗口结束：把累积的消息当作一轮交给上层 */
  async #flushPending(userId) {
    const p = this.mergePending.get(userId)
    if (!p) return
    this.mergePending.delete(userId)
    clearTimeout(p.timer)
    if (p.count > 1) this.logger.info(`[merge] 窗口结束，${p.count} 条消息并为一轮处理`)
    await this.#dispatchInbound(p.inbound)
  }

  /**
   * 本轮处理允许花多久。
   *
   * 为什么不能写死 90s：
   *   · provider 自己的请求超时是 **120s**（client.js）——比 90s 还长，慢一轮就会被误判超时；
   *   · 委托的预算是「硬超时 × (1+续跑)」，默认就是 195s×2 —— 委托**必然**超时，
   *     接收方收到的是一句「⚠️ 处理这条消息出错：消息处理超时（90s）」，
   *     而活还在后台跑，跑完的结果没处可去（日志里 03:56:07 就是这种）。
   * 所以底数取 150s（> provider 的 120s），长的活靠 `extendTimeout` **运行时申请**。
   */
  #handleTimeoutMs() {
    const v = Number(this.config.channel?.handleTimeoutMs)
    // 只有「没配 / 配成非正数」才回落默认；**不要**用 Math.max 抬下限——
    // 那样测试中配置的 200ms 会被抬到 5s，测试结果不再对应配置值
    return Number.isFinite(v) && v > 0 ? v : 150000
  }

  /**
   * 交给上层处理（带超时与错误回复）。
   * 第二个参数给上半层一个「申请延长本轮时限」的口子（委托这类真的要算很久的活必须能申请）。
   */
  async #dispatchInbound(inbound) {
    this.logger.info('[channel] 交由上层处理')
    const startedAt = Date.now()
    // 时长文案：过 1s 就说秒，否则说毫秒（自检里配的是 200ms，别显示成「超时（0s）」）
    const dur = (ms) => (ms >= 1000 ? Math.round(ms / 1000) + 's' : Math.round(ms) + 'ms')
    let deadline = startedAt + this.#handleTimeoutMs()
    let timer = null
    let rejectTurn = null
    let settled = false
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!settled && rejectTurn) {
          rejectTurn(new Error(`消息处理超时（${dur(deadline - startedAt)}）`))
        }
      }, Math.max(1, deadline - Date.now()))
      timer.unref?.()
    }
    /** 本轮申请延长时限；返回还剩多少毫秒（已结束/没给数就返回 0） */
    const extendTimeout = (ms) => {
      const add = Math.max(0, Number(ms) || 0)
      if (!add || settled) return 0
      deadline += add
      this.logger.info(`[channel] 本轮申请延长处理时间 +${dur(add)}（本轮总上限 ${dur(deadline - startedAt)}）`)
      arm()
      return Math.max(0, deadline - Date.now())
    }
    try {
      await Promise.race([
        this.onMessage?.(inbound, { extendTimeout }),
        new Promise((_, reject) => {
          rejectTurn = reject
          arm()
        })
      ])
    } catch (err) {
      this.logger.error('处理消息出错：', err.message)
      await this.sendText(inbound.userId, `⚠️ 处理这条消息出错：${err.message}`, inbound.contextToken).catch(() => {})
    } finally {
      settled = true
      clearTimeout(timer)
    }
  }

  /** 原始长文本发送：仅按长度切分，不做语义分段（用于导出 JSON） */
  async sendRaw(toUserId, text, contextToken) {
    await this.sendText(toUserId, text, contextToken)
  }

  /**
   * 发送单条文本（超长按长度切分，不拆分语义分段），用于 /cot 与 /export。
   *
   * 发不出去同样不丢：把**还没送出去的块**落盘排队（一次失败只影响它之后的块，
   * 已经送出去的块不会重复发）。但块数多于 pendingMaxChunks 时改为抛出：
   * 几百块的长导出塞进队列会撞上限，被丢掉的尾部就成了**静默截断**——
   * 那比「明确失败、请重新执行命令」更糟（/export 在容器内还留着副本）。
   */
  async sendText(toUserId, text, contextToken) {
    if (!text) return
    const chunks = chunkText(text, this.config.reply?.maxCharsPerMessage || 1800)
    for (let i = 0; i < chunks.length; i++) {
      const ok = await this.sendTextMsg(toUserId, chunks[i], contextToken, { tries: 3, label: '文本' })
      if (!ok) {
        const rest = chunks.slice(i)
        const maxChunks = Number(this.config.reply?.pendingMaxChunks ?? 20)
        if (rest.length > maxChunks) {
          throw new Error(`文本发送失败（剩余 ${rest.length} 块超出排队上限，可能触发通道限流，稍后重新执行本命令）`)
        }
        const { queued } = enqueuePending(
          this.dataDir,
          rest.map((t) => ({ userId: toUserId, contextToken, text: t })),
          { cap: Number(this.config.reply?.pendingMaxItems ?? 500) }
        )
        this.logger.warn(`文本发送受阻，剩余 ${rest.length} 块已存入待发队列（队列 ${queued} 条），恢复后自动补发`)
        return
      }
    }
    void this.drainPending()
  }

  /**
   * 这个用户**最后已知**的 context_token。
   *
   * 为什么需要：委托改成后台跑之后，「结果」是在几分钟之后才回的话，
   * 那时早就不在任何一轮入站里了。token 已在 `handleRaw` 里持久化（`ctxToken:<uid>`），
   * 这里只是把它读出来（内存里没有就回落到磁盘，重启也不丢）。
   * 过期了怎么办：`sendReply` 发不出去会落到**待发队列**（下次入站补发），不会默默丢掉。
   */
  lastTokenFor(userId) {
    if (!userId) return null
    if (this.lastTokens.has(userId)) return this.lastTokens.get(userId)
    try {
      return this.store.get('ctxToken:' + userId) || null
    } catch (_) {
      return null
    }
  }

  /**
   * 发送回复：按分句拆成多条消息逐条发送，条间加入拟人停顿。
   * （角色扮演提示词要求逐行分段，这里对应「像人类聊天逐条发送」）
   *
   * 分段条数上限（reply.maxSegmentsPerReply，默认 10）：
   *   一次回复超过约 10 条时会出现 ret=-2 prepare failed，且触发后数秒内
   *   连单条也发不出去。因此先把超长回复合并到上限以内，
   *   而不是等第 11 条擞墙后再把剩余内容挤成一条重试。
   */
  async sendReply(toUserId, text, contextToken) {
    if (!text) return
    // 没给 token 就用「最后已知」的那个：委托结果这种「几分钟后才回的话」
    // 根本没有本轮 token 可传，而待发队列 / 只发文字的场景也会走这里。
    const token = contextToken || this.lastTokenFor(toUserId)
    const replyCfg = this.config.reply || {}
    const rawSegs = splitSegments(text, replyCfg)
    const maxSeg = Number(replyCfg.maxSegmentsPerReply ?? 10)
    const segs = capSegments(rawSegs, maxSeg)
    if (segs.length < rawSegs.length) {
      this.logger.info(`分段 ${rawSegs.length} 条超出上限 ${maxSeg}，已合并为 ${segs.length} 条`)
    }
    const base = replyCfg.segmentDelayMs ?? 1200
    const jitter = replyCfg.segmentJitterMs ?? 500
    this.logger.info(`→ 发送回复（${segs.length} 段）to=${toUserId} 额度=${this.limiter.quota}`)
    for (let i = 0; i < segs.length; i++) {
      this.logger.info(`   [${i + 1}/${segs.length}] ${JSON.stringify(segs[i].slice(0, 80))}`)
      const ok = await this.sendTextMsg(toUserId, segs[i], token, { tries: 3, label: `分段 ${i + 1}/${segs.length}` })
      if (!ok) {
        // 连续失败（多为限流）：把剩余内容合并成一条再试，能少发一条是一条
        const rest = segs.slice(i).join('\n')
        this.logger.warn('分段发送受阻，改为合并剩余 ' + (segs.length - i) + ' 段重试')
        const ok2 = await this.sendTextMsg(toUserId, rest, token, { tries: 2, label: '合并重试' })
        if (!ok2) {
          // ⚠️ 这里**绝对不能一抛了之**：抛出去等于这段内容从世界上消失——
          // 用户等半天什么都没收到，只在日志里留一行 WARN。
          // 改为落盘排队（data/pending-replies.json），限流恢复后由 drainPending 补发。
          const { queued, dropped } = enqueuePending(this.dataDir, [{ userId: toUserId, contextToken: token, text: rest }], {
            cap: Number(this.config.reply?.pendingMaxItems ?? 500)
          })
          this.logger.warn(`发送受阻，剩余内容已存入待发队列（队列 ${queued} 条），恢复后自动补发`)
          if (dropped) this.logger.error(`待发队列超过上限，丢弃了最旧的 ${dropped} 条（请检查微信侧限流是否长期未恢复）`)
          return
        }
        return
      }
      if (i < segs.length - 1) {
        // 拟人停顿：基础值 + 少量长度相关 + 随机抖动（避免固定节奏触发限流）
        await sleep(base + Math.min(segs[i].length * 8, 600) + Math.floor(Math.random() * jitter))
      }
    }
    // 这一轮全发出去，说明账号已经恢复 → 顺手把待发队列清一清
    void this.drainPending()
  }

  /**
   * 补发待发队列。
   *
   * 设计取舍：
   *   · 每条只试 1 次（tries:1）——它已经在队列里等过了，不在这里做三段重试，
   *     否则一轮补发能把窗口额度全耗光，正常对话反而被饿死；
   *   · 失败即**整轮停**：限流是账号级的，这一条发不出去后面多半也发不出去，
   *     继续重试只会把冷却拖得更长；
   *   · 走同一个 limiter，不绕过限流——补发的是真内容，但不该享有特权。
   */
  async drainPending() {
    if (!this.dataDir) return { sent: 0, left: 0, skipped: true }
    if (this.draining) return { sent: 0, left: 0, skipped: true }
    const list = readPending(this.dataDir)
    if (!list.length) return { sent: 0, left: 0 }
    this.draining = true
    try {
      let i = 0
      for (; i < list.length; i++) {
        const item = list[i]
        // 补发时优先用**最新**的 token：入队时那个可能已经过期了
        // （它只影响报文里的 context_token 字段，但过期就可能一直补不出去）
        const ok = await this.sendTextMsg(item.userId, item.text, item.contextToken || this.lastTokenFor(item.userId), {
          tries: 1,
          label: '补发'
        })
        if (!ok) break
        this.logger.info('待发补发成功：' + JSON.stringify(String(item.text).slice(0, 40)))
      }
      const left = list.slice(i)
      // 只给「卡住的那一条」累加次数，方便日后判断是限流还是内容本身的问题
      if (left.length) left[0] = { ...left[0], tries: (left[0].tries || 0) + 1 }
      writePending(this.dataDir, left)
      if (i > 0) this.logger.info(`待发队列补发 ${i} 条，剩余 ${left.length} 条`)
      // 队头连续失败很多次就不再像「限流」了（限流是分钟级的，早该恢复）：
      // 说清楚，别让人只看见次数在涨（此时它会一直堵着后面的，这是已知取舍）
      if (left.length && left[0].tries === 10) {
        this.logger.error('待发队列队头连续 10 次补发失败：可能不是限流，而是这条内容本身发不出去（/pending 看预览）')
      }
      return { sent: i, left: left.length }
    } finally {
      this.draining = false
    }
  }

  /** 待发队列概况（/status 用） */
  pendingStats() {
    return pendingStats(this.dataDir)
  }

  /**
   * 统一发送出口：取限流许可 → 发请求 → 校验业务 ret → 把结果反馈给限流器。
   *
   * 为何只在这里限流：
   *   旧实现里 #sendWithRetry 与 #sendOnce 各自调了一次 #throttle，
   *   同一条消息占两个窗口额度（实际吞吐只有配置的一半），
   *   而媒体发送（文件/图片）则完全没走限流。
   */
  async #sendMsg(msg, { tries = 3, label = '消息' } = {}) {
    const path = '/ilink/bot/sendmessage'
    for (let n = 0; n < tries; n++) {
      await this.limiter.acquire()
      try {
        const resp = await apiRequest(this.baseUrl, path, {
          method: 'POST',
          body: { msg, base_info: buildBaseInfo(this.config) },
          token: this.creds.token,
          cfg: this.config,
          timeout: 30000
        })
        assertBizOk(resp, path)
        this.limiter.onSuccess()
        return true
      } catch (e) {
        if (e.ret === -2) this.limiter.onThrottled()
        const retriable = e.ret === -2 || e.code === 'ETIMEDOUT' || e.ret === undefined
        this.logger.warn(`发送失败（${label}，第 ${n + 1}/${tries} 次）：${e.message}`)
        if (!retriable || n === tries - 1) return false
        await sleep(1500 * (n + 1))
      }
    }
    return false
  }

  /**
   * 发送文本消息。
   * 公开（原为 #sendTextMsg）的两个理由：
   *   ① 它是通道**唯一的文本出口**，待发队列的补发要复用同一条路径；
   *   ② 测试需要能替换它（selftest 用假出口验证「发不出去 → 落盘 → 补发」）。
   */
  sendTextMsg(toUserId, text, contextToken, opts) {
    return this.#sendMsg(buildOutgoingText({ toUserId, text, contextToken }), opts)
  }

  /** 发送任意 item（图片/文件/视频） */
  #sendItem(toUserId, item, contextToken, opts) {
    return this.#sendMsg(buildOutgoingItem({ toUserId, item, contextToken }), opts)
  }

  /** 上传媒体到 CDN，返回 media 引用所需数据 */
  async #uploadMedia(buffer, mediaType, toUserId, maxBytes) {
    if (!buffer?.length) throw new Error('媒体内容为空')
    // ⚠️ 运行时护栏：调用方**必须**传 Buffer。
    //    曾经 router.js 里的 sendImage 包装签名写成了 (buf)，而工具是按 fn(name, buf) 调的，
    //    于是**文件名**成了「媒体内容」：字符串也有 .length，所以校验一路通过，
    //    最后只在日志里看到一句莫名其妙的 HTTP 500（16 字节 = AES 补齐后的文件名长度），
    //    而工具又按设计退化成文件通道 → 接收方收到的永远是「要点开的文件」。
    //    这里当场拦下：错的层自己报出来，别让人和日志都去猜。
    if (!Buffer.isBuffer(buffer)) {
      throw new Error(
        `媒体内容必须是 Buffer，实际是 ${typeof buffer}` +
          (typeof buffer === 'string' ? `（"${buffer.slice(0, 40)}"）` : '') +
          '——多半是调用方参数顺序错了：应为 (toUserId, buffer, ...)'
      )
    }
    const limit = maxBytes ?? this.config.media?.maxSendBytes ?? 20 * 1024 * 1024
    if (buffer.length > limit) throw new Error(`媒体过大（${buffer.length}B，上限 ${limit}B），暂不支持发送`)
    const tries = Math.max(1, Number(this.config.media?.uploadTries ?? 3))
    const timeoutMs = Math.max(5000, Number(this.config.media?.uploadTimeoutMs ?? 60000))
    let lastErr = null
    for (let i = 1; i <= tries; i++) {
      try {
        return await this.#uploadOnce(buffer, mediaType, toUserId, timeoutMs)
      } catch (e) {
        lastErr = e
        // 见下方注释：CDN 会偶发 500 / 卡住，所以换一个新 filekey 重试（每次上传都是新 key，重试安全）
        if (e && e.retryable === false) break
        if (i < tries) {
          this.logger.warn(`[upload] 第 ${i}/${tries} 次上传失败（${e.message}），换新 filekey 重试`)
          // 失败后**等一下**再试：三次挤在同一毫秒里往往撞到同一个后端（实际运行中三条 500 全在同一秒）
          await sleep(400 * i)
        }
      }
    }
    throw lastErr
  }

  /**
   * 一次上传尝试（取地址 + PUT 密文）。
   *
   * 两件事都是实际运行中出现过：
   *   ① **PUT 必须自己带超时**：原来只有 getuploadurl 那一步有 30s 超时，PUT 是无保护的，
   *       CDN 卡住就会一直挂着 → 整轮被通道的 150s 判超时，用户收到「处理消息出错」。
   *   ② **CDN 会偶发 500 / 卡住**：探针里连续上传时，第一笔 200、第二笔就卡住不动了；
   *      实际运行中也出现过两次「媒体上传失败 HTTP 500」（响应体空）。所以重试要有（见 #uploadMedia），
   *      并且 5xx/超时这类才重试，4xx（签名/参数错）重试没意义。
   */
  async #uploadOnce(buffer, mediaType, toUserId, timeoutMs) {
    const meta = buildUploadMeta(buffer)

    const upPath = '/ilink/bot/getuploadurl'
    const upResp = await apiRequest(this.baseUrl, upPath, {
      method: 'POST',
      body: {
        filekey: meta.filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: meta.rawsize,
        rawfilemd5: meta.rawfilemd5,
        filesize: meta.filesize,
        no_need_thumb: true,
        aeskey: meta.aeskeyHex,
        base_info: buildBaseInfo(this.config)
      },
      token: this.creds.token,
      cfg: this.config,
      timeout: 30000
    })
    assertBizOk(upResp, upPath)

    const uploadUrl = upResp.upload_full_url
    if (!uploadUrl || !/^https:\/\//i.test(uploadUrl)) {
      throw new Error('未获取到可信的上传地址（upload_full_url），响应字段=' + Object.keys(upResp).join(','))
    }
    // PUT 使用独立连接，不使用进程里的 keep-alive 连接池。
    // 失败信息保留 host、状态码和已发送字节数，便于定位参数或上传错误。
    const putRes = await this.putImpl(uploadUrl, meta.cipher, timeoutMs, this.logger)
    if (putRes.status !== 200) {
      const host = (() => {
        try {
          return new URL(uploadUrl).host
        } catch (_) {
          return '?'
        }
      })()
      const err = new Error(
        `媒体上传失败 HTTP ${putRes.status}（host=${host}` +
          (putRes.headers.server ? ', server=' + putRes.headers.server : '') +
          `, ${putRes.bytes} 字节已发出）` +
          (putRes.body ? '：' + String(putRes.body).slice(0, 200) : '')
      )
      // 4xx = 签名/参数不对，重试也不会变好；5xx/429 = 对方抖动，值得重试
      if (!(putRes.status >= 500 || putRes.status === 429)) err.retryable = false
      throw err
    }
    const encryptedParam = putRes.headers['x-encrypted-param']
    if (!encryptedParam) throw new Error('上传响应缺少 x-encrypted-param')

    // ⚠️ 与官方实现对齐：media.aes_key 是「AES key 十六进制字符串」的 base64，
    // 不是 16 字节原始 key 的 base64（Buffer.from(hexString) 取的是 hex 的 ASCII 字节）。
    return {
      media: {
        encrypt_query_param: encryptedParam,
        aes_key: Buffer.from(meta.aeskeyHex).toString('base64'),
        encrypt_type: 1
      },
      aesKeyHex: meta.aeskeyHex,
      rawSize: meta.rawsize,
      encryptedSize: meta.filesize
    }
  }

  /**
   * 发送文件（.json 等）
   * @param {object} [opts] { lenAsNumber } 用于诊断 len 字段类型
   */
  async sendFile(toUserId, buffer, fileName, contextToken, opts = {}) {
    const up = await this.#uploadMedia(buffer, 3, toUserId)
    const item = {
      type: 4,
      file_item: {
        media: up.media,
        file_name: fileName,
        len: opts.lenAsNumber ? up.rawSize : String(up.rawSize)
      }
    }
    const ok = await this.#sendItem(toUserId, item, contextToken, { tries: 3, label: '文件 ' + fileName })
    if (!ok) throw new Error('文件发送失败（' + fileName + '）')
    this.logger.info(`→ 已发送文件 ${fileName}（${up.rawSize}B, len=${opts.lenAsNumber ? 'number' : 'string'}）`)
  }

  /** 发送图片 */
  async sendImage(toUserId, buffer, contextToken) {
    const up = await this.#uploadMedia(buffer, 1, toUserId)
    const item = {
      type: 2,
      image_item: { media: up.media, mid_size: up.encryptedSize }
    }
    const ok = await this.#sendItem(toUserId, item, contextToken, { tries: 3, label: '图片' })
    if (!ok) throw new Error('图片发送失败')
    this.logger.info(`→ 已发送图片（${up.rawSize}B）`)
  }

  /**
   * 发送视频（P7）。
   *
   * 👍 已回发 589939B 的 mp4，用 video_item + video_size 即可送达。
   *
   * 视频通道可能会压缩内容。需要保留原文件时走文件通道（sendFile，media_type 3）。
   * 出站视频 item 结构：{ type:5, video_item:{ media:{...}, video_size:<大小> } }
   *
   * @param {object} [opts] { fileName, sizeField }
   */
  async sendVideo(toUserId, buffer, contextToken, opts = {}) {
    const limit = this.config.media?.maxVideoBytes ?? 10 * 1024 * 1024
    const up = await this.#uploadMedia(buffer, 2, toUserId, limit)
    const sizeField = opts.sizeField || this.config.media?.videoSizeField || 'video_size'
    const videoItem = { media: up.media, [sizeField]: up.encryptedSize }
    if (opts.fileName) videoItem.file_name = opts.fileName
    const ok = await this.#sendItem(toUserId, { type: 5, video_item: videoItem }, contextToken, { tries: 2, label: '视频' })
    if (!ok) throw new Error('视频发送失败（sizeField=' + sizeField + '）')
    this.logger.info(`→ 已发送视频（${up.rawSize}B，sizeField=${sizeField}）`)
    return { rawSize: up.rawSize, sizeField }
  }

  /**
   * 「正在输入」状态。按文档：先 getconfig 取 typing_ticket，再 sendtyping(status)。
   * status: 1=正在输入，2=取消。失败不影响正常回复。
   */
  async sendTyping(toUserId, contextToken, status = 1) {
    if (this.config.typing?.enabled === false) return
    try {
      let ticket = this.store.get('typingTicket:' + toUserId)
      if (!ticket) {
        const cPath = '/ilink/bot/getconfig'
        const cresp = await apiRequest(this.baseUrl, cPath, {
          method: 'POST',
          body: { ilink_user_id: toUserId, context_token: contextToken || '', base_info: buildBaseInfo(this.config) },
          token: this.creds.token,
          cfg: this.config,
          timeout: 8000
        })
        assertBizOk(cresp, cPath)
        ticket = cresp.typing_ticket
        if (ticket) this.store.set('typingTicket:' + toUserId, ticket)
      }
      if (!ticket) return
      const path = '/ilink/bot/sendtyping'
      await apiRequest(this.baseUrl, path, {
        method: 'POST',
        body: { ilink_user_id: toUserId, typing_ticket: ticket, status, base_info: buildBaseInfo(this.config) },
        token: this.creds.token,
        cfg: this.config,
        timeout: 8000
      })
    } catch (err) {
      this.logger.debug('输入状态失败（忽略）：', err.message)
    }
  }
}
