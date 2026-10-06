/**
 * 语音识别（ASR）：把对方发来的语音变成文字。
 *
 * 为什么单独成一个模块（而不是塞进 perception 或 tools）：
 *   · 工具是「模型主动去查」，感知是「每轮自动到达的事实」，而这个是**入站输入的转换**——
 *     发生在拼提示词之前，和「图片转成多模态块」是同一层，所以两处都不合适。
 *   · 协议层还欠一条：**只有语音、没有文字**的消息原本在 router 的 `if (!text)` 里被静默丢弃
 *     ，接 ASR 之前必须先把那条链路补上（见 router.handleVoice）。
 *
 * 链路：
 *   微信语音（SILK，文件头 `\x02#!SILK_V3`，一般是 24kHz）→ silk-wasm 解成 PCM
 *   → 自己包一个 WAV（**不能信 wav 里 data chunk 的长度字段**，曾出现 0xFFFFFFF0）
 *   → multipart 打 `POST {baseUrl}/audio/transcriptions`。
 *
 * 为什么用 silk-wasm 而不是 ffmpeg：容器里没有 ffmpeg / ffprobe / sox（连 python3、curl 都没有），
 * 而 silk-wasm 是纯 WASM（MIT、零依赖、304KB），`npm i` 就能用，不必往镜像里塞二进制。
 * 它是**动态 import**：没装就如实报「解码器不可用」，绝不让整个服务起不来。
 *
 * 模型比较（同一句话、同一段音频，三种模型都一字不差）：
 *   `Qwen/Qwen3-ASR-1.7B` 381ms｜`XingChenAGI/XingChenASR-V3.2` 453ms（价格页显示**免费**）
 *   ｜`FunAudioLLM/SenseVoiceSmall` **168 秒**（冷启动巨慢，还会附一个表情符号）→ 不作默认。
 *   对照：解出 SILK 再识别 与 直接喂原始 wav 结果一致 ⇒ 解码这一步不掉质量。
 *
 * 两个接口限制：① ASR 只认 multipart（`audio` 字段传 base64 JSON → 500）；
 * ② `/v1/user/info` 查余额已废弃（410），所以单价只能去控制台看，代码里不猜。
 */

/** SILK 文件头：0x02 + `#!SILK`（V3 是 0x02 0x23 0x21 'SILK_V3'） */
export const SILK_MAGIC = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b])

/**
 * SILK 解码时的候选采样率。
 * 为什么是「候选」而不是一个值：SILK 头里**没有**采样率字段（微信一般按 24kHz 编码），
 * 猜错的后果不是报错，而是**变速播放**——识别出来是乱码或空。所以宁可空结果时换一个再试。
 */
export const SILK_SAMPLE_RATES = [24000, 16000, 8000]

/** 按文件头判断音频格式（不依赖扩展名：微信来的东西本来就没有可信的扩展名） */
export function detectAudioFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown'
  const head12 = buf.subarray(0, 12).toString('latin1')
  if (buf.length >= 7 && buf.subarray(0, 7).equals(SILK_MAGIC)) return 'silk'
  if (head12.startsWith('#!AMR')) return 'amr'
  if (head12.startsWith('RIFF')) return 'wav'
  if (head12.startsWith('ID3')) return 'mp3'
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'
  if (head12.startsWith('OggS')) return 'ogg'
  if (head12.startsWith('Speex')) return 'speex'
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4'
  return 'unknown'
}

const FORMAT_MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  mp4: 'audio/mp4',
  speex: 'audio/speex'
}

/** PCM(s16le 单声道) → WAV。自己写而不复用别人的解析：见文件头「不能信 data chunk 长度」那条 */
export function wavFromPcm(pcm, sampleRate) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/**
 * 去掉识别结果里的**非语音内容**。
* 为什么需要：SenseVoice 这类模型会在正文后附加表情符号，
 * 那是模型对语气的标注，不是对方说出口的话——直接进对话历史会被当范例学。
 * 注意只清理「表情符号 + 首尾空白」，`[音乐]`、`（笑）` 这类**内容**要留着（那些真发生过）。
 */
export function stripNonSpeech(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .trim()
}

const K = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB')

/**
 * @param {object} opts
 * @param {import('../config/store.js').ConfigStore} [opts.configStore] 每轮实时读配置（`/asr` 改完立即生效）
 * @param {Function} [opts.loadCodec] 注入 SILK 解码器（自检用假件，避免测试依赖 wasm）
 * @param {Function} [opts.importImpl] 注入动态 import（自检用：验证「第一次没装、第二次装上了」的自愈）
 * @param {Function} [opts.fetchImpl] 注入 fetch（自检替掉真实网络）
 */
export function createAsr({ configStore, config, providerStore, logger, loadCodec, importImpl, fetchImpl } = {}) {
  const options = () => (configStore?.get?.() || config || {}).asr || {}
  const log = logger || { info() {}, warn() {}, debug() {} }
  let codecPromise = null
  let codecState = 'unknown' // unknown | ok | missing | broken（只用于如实展示，判断能力请看 available()）
  let last = null // 最近一条语音（只留内存：**音频不落盘**，语音比图片私密）
  let lastBuf = null
  const doImport = importImpl || ((name) => import(name))

  /**
   * 默认解码器：动态 import，没装就是 null（不抛，让可用性检查去如实回答）。
   * ⚠️ **失败不进缓存**：一开始失败就把结果永久记住的话，事后装上 silk-wasm
   * 也得重启服务才能生效（实际运行中出现过：装在 /repo/server 而不是运行目录 /app，
   * 修好路径后发现进程仍然说「没装解码器」）。所以失败时把缓存放回去，下次再试。
   */
  async function defaultLoadCodec() {
    if (!codecPromise) {
      codecPromise = doImport('silk-wasm')
        .then((m) => {
          codecState = 'ok'
          return m
        })
        .catch((e) => {
          log.warn('[asr] silk-wasm 不可用（语音会解不开）：' + e.message)
          codecState = 'missing'
          codecPromise = null // 下次调用再试一次，安装后可以重新尝试
          return null
        })
    }
    return codecPromise
  }
  const getCodec = loadCodec || defaultLoadCodec

  /**
   * 解码器用坏了（wasm 初始化失败 / 文件缺失）时登记一下。
   *
   * 为什么要专门处理：silk-wasm 是 Emscripten 产物，wasm 一旦初始化失败，
   * 它内部那个单例 Promise 就永久坏掉，后续调用会抛出逃出 await 的 RuntimeError。
   * 所以：① 把缓存清掉，下次重新 import（万一之后被修好）；② 状态如实记成 broken，
   * /asr 会直接显示出来，而不是每次语音都报一个看不懂的 Emscripten 堆栈。
   */
  function markCodecBroken(e) {
    codecState = 'broken'
    codecPromise = null
    log.warn('[asr] SILK 解码器坏了（下次语音会重试）：' + (e && e.message))
  }

  /** 主动探一下解码器装没装（`/asr` 用；热路径不用它，避免每次调用都做异步探测） */
  async function probeCodec() {
    if (loadCodec) {
      const c = await loadCodec()
      return { ok: Boolean(c), reason: c ? null : '解码器不可用（注入的实现返回空）' }
    }
    const c = await getCodec()
    return { ok: Boolean(c), reason: c ? null : '没装 silk-wasm（装上后**不用重启**，下次语音会自动再试）' }
  }

  /** 用哪家、有没有钥匙（默认复用现有 Provider，不单独再配一遍 key） */
  function providerInfo() {
    const opt = options()
    const id = opt.provider || 'deepseek'
    const p = providerStore?.get?.(id) || null
    if (!p) return { id, ok: false, reason: '没有这个服务商：' + id + '（/provider 查看）' }
    if (!p.apiKey) return { id, ok: false, reason: '服务商 ' + id + ' 没配密钥' }
    return { id, ok: true, baseUrl: p.baseUrl, apiKey: p.apiKey }
  }

  /** 现在能不能干活（命令与提示都以此为准，绝不假装能做） */
  function available() {
    const opt = options()
    if (opt.enabled === false) return { ok: false, reason: '语音识别已关闭（/asr on 打开）' }
    const pv = providerInfo()
    if (!pv.ok) return { ok: false, reason: pv.reason }
    return { ok: true, reason: null }
  }

  /** 把一段音频准备成「能交给识别接口的字节」：SILK 要解码，其他格式原样透传 */
  async function prepare(buf, rate) {
    const fmt = detectAudioFormat(buf)
    if (fmt === 'silk') {
      const codec = await getCodec()
      if (!codec) throw new Error('服务器没装 SILK 解码器（silk-wasm）')
      const used = Number(rate) || SILK_SAMPLE_RATES[0]
      let dec
      try {
        dec = await codec.decode(buf, used)
      } catch (e) {
        markCodecBroken(e)
        throw new Error('SILK 解码失败：' + e.message)
      }
      const wav = wavFromPcm(Buffer.from(dec.data), used)
      return { wav, format: fmt, sampleRate: used, name: 'voice.wav', mime: 'audio/wav' }
    }
    if (FORMAT_MIME[fmt]) {
      return { wav: buf, format: fmt, sampleRate: null, name: 'voice.' + fmt, mime: FORMAT_MIME[fmt] }
    }
    throw new Error('不认识的音频格式（文件头 ' + JSON.stringify(buf.subarray(0, 8).toString('latin1')) + '）')
  }

  /** 真的打一次识别接口（`model` 单拿出来：说话人判定要换模型走同一条路） */
  async function callAsr(prepared, opt, pv, model) {
    const fd = new FormData()
    fd.append('file', new Blob([prepared.wav], { type: prepared.mime }), prepared.name)
    fd.append('model', model || opt.model)
    const ac = new AbortController()
    const timeoutMs = Math.max(1000, Number(opt.timeoutMs) || 30000)
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const r = await (fetchImpl || fetch)(String(pv.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + pv.apiKey },
        body: fd,
        signal: ac.signal
      })
      const text = await r.text()
      const ms = Date.now() - t0
      // 失败也要把诊断留下（响应体是唯一线索，别只留一句「识别失败」）
      if (!r.ok) return { ok: false, ms, reason: '识别接口 HTTP ' + r.status + '：' + text.slice(0, 200) }
      let j = null
      try {
        j = JSON.parse(text)
      } catch (_) {
        return { ok: false, ms, reason: '识别接口返回的不是 JSON：' + text.slice(0, 200) }
      }
      const raw = j.text ?? j.data?.text ?? j.result ?? ''
      // 把解析后的 JSON 也带回去：说话人分段（segments）在里面，用不到就当没看见
      return { ok: true, ms, text: stripNonSpeech(raw), raw: String(raw || ''), json: j }
    } catch (e) {
      const ms = Date.now() - t0
      const why = e.name === 'AbortError' ? '识别超时（' + timeoutMs + 'ms）' : e.message
      return { ok: false, ms, reason: why }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 识别一段音频。
   * @returns {Promise<{ok:boolean, text?:string, reason?:string, format:string, model:string, ms:number, attempts:number, sampleRate:number|null}>}
   */
  async function transcribe(buf) {
    const opt = options()
    const model = opt.model || ''
    const base = { format: detectAudioFormat(buf), model, ms: 0, attempts: 0, sampleRate: null }
    const avail = available()
    if (!avail.ok) return { ...base, ok: false, reason: avail.reason }
    if (!model) return { ...base, ok: false, reason: '没配模型名（/asr model <模型名>）' }
    if (!buf || !buf.length) return { ...base, ok: false, reason: '空音频' }
    const maxBytes = Number(opt.maxBytes) || 4 * 1024 * 1024
    if (buf.length > maxBytes) return { ...base, ok: false, reason: '音频太大（' + K(buf.length) + ' > 上限 ' + K(maxBytes) + '）' }
    const pv = providerInfo()

    // SILK 才需要「猜采样率」：空结果就换下一个速率（不报错、自己自愈）
    const rates = base.format === 'silk' ? [Number(opt.sampleRate) || SILK_SAMPLE_RATES[0], ...SILK_SAMPLE_RATES].filter((v, i, a) => v && a.indexOf(v) === i) : [null]
    let msTotal = 0
    let lastEmpty = null
    let attempts = 0
    for (const rate of rates) {
      let prepared
      try {
        prepared = await prepare(buf, rate)
      } catch (e) {
        return { ...base, ok: false, reason: e.message, ms: msTotal }
      }
      attempts += 1
      const r = await callAsr(prepared, opt, pv, opt.model)
      msTotal += r.ms
      if (!r.ok) {
        // 接口层失败（HTTP/网络/超时）：换速率也没用，直接报出去
        return { ...base, ok: false, reason: r.reason, ms: msTotal, attempts, sampleRate: prepared.sampleRate }
      }
      if (r.text) {
        // 说话人判定（用户 定的口径：**只判定「这条里有没有第二个人在说话」**，
        // 不用它出文字 —— diarize 模型的转写质量略差（转写可能出现近音错误），
        // 所以文字仍由普通模型出，这里多跑一次只为「几个人」。
        // XingChen 那几个模型在价格页上是免费档，所以这次多花的只是 ~0.8s 延迟；
        // 判定失败**不能拖倒整条识别**（拿不到就当不知道，宁可不说，也不能猜）。
        let speakers = null
        if (opt.diarize?.enabled !== false) {
          try {
            speakers = await countSpeakers(prepared, opt, pv)
            msTotal += speakers.ms
          } catch (e) {
            log.warn('[asr] 说话人判定失败（不影响识别）：' + e.message)
          }
        }
        return { ...base, ok: true, text: r.text, ms: msTotal, attempts, sampleRate: prepared.sampleRate, speakers }
      }
      lastEmpty = { ...base, ok: false, reason: '识别结果为空（没听清 / 或采样率不对）', ms: msTotal, attempts, sampleRate: prepared.sampleRate }
    }
    return lastEmpty || { ...base, ok: false, reason: '识别失败' }
  }

  /**
   * 数一数这段音频里有几个说话人。
   * 返回 `{ count, ms, model, raw }`；拿不到就招错（调用方自己决定要不要降级）。
   */
  async function countSpeakers(prepared, opt, pv) {
    const model = opt.diarize?.model || 'XingChenAGI/XingChenASR-Diarize-V3.0'
    const r = await callAsr(prepared, opt, pv, model)
    if (!r.ok) throw new Error(r.reason)
    const j = r.json || {}
    const ids = new Set()
    for (const seg of (j && j.segments) || []) {
      if (seg && seg.speaker != null && String(seg.speaker) !== '') ids.add(String(seg.speaker))
    }
    // 有些实现只在 text 里写「1: …」，没有 segments → 从行首数字兑底
    if (!ids.size && typeof j?.text === 'string') {
      for (const line of j.text.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s*[:：]/.exec(line)
        if (m) ids.add(m[1])
      }
    }
    return { count: ids.size, ids: [...ids], ms: r.ms, model, raw: j }
  }

  /** 记下最近一条语音（供 `/asr last` 与 `/asr test`；只留在内存里，音频不落盘） */
  function remember(info) {
    last = { at: Date.now(), ...info }
    if (info && info.buf) lastBuf = info.buf
  }

  const lastResult = () => (last ? { ...last } : null)

  /** `/asr test`：把最近那条语音重跑一遍（验证链路，不用等对方再发一条） */
  async function retest() {
    if (!lastBuf || !lastBuf.length) return { ok: false, reason: '还没有收到过语音，先让对方法一条' }
    return transcribe(lastBuf)
  }

  /** 供 `/asr` 展示的状态行 */
  function status() {
    const opt = options()
    const pv = providerInfo()
    const avail = available()
    const l = last
    const silkRate = {
      '24000': '24kHz（微信默认）',
      '16000': '16kHz',
      '8000': '8kHz'
    }[String(Number(opt.sampleRate) || SILK_SAMPLE_RATES[0])]
    return {
      enabled: opt.enabled !== false,
      mode: opt.mode === 'chat' ? 'chat' : 'probe',
      model: opt.model || '(未配)',
      provider: pv.id,
      providerOk: pv.ok,
      providerReason: pv.reason,
      sampleRate: Number(opt.sampleRate) || SILK_SAMPLE_RATES[0],
      timeoutMs: Number(opt.timeoutMs) || 30000,
      maxBytes: Number(opt.maxBytes) || 4 * 1024 * 1024,
      usable: avail.ok,
      usableReason: avail.reason,
      codecState,
      silkRateLabel: silkRate,
      diarize: opt.diarize?.enabled !== false,
      diarizeNotify: opt.diarize?.notify === true,
      diarizeModel: opt.diarize?.model || 'XingChenAGI/XingChenASR-Diarize-V3.0',
      last: l
        ? {
            at: l.at,
            format: l.format,
            bytes: l.bytes,
            ok: l.ok,
            text: l.text || null,
            reason: l.reason || null,
            ms: l.ms || 0,
            attempts: l.attempts || 0,
            sampleRate: l.sampleRate ?? null,
            speakers: l.speakers ? l.speakers.count : null,
            itemFields: l.itemFields || null
          }
        : null
    }
  }

  return { options, providerInfo, available, detectAudioFormat, prepare, transcribe, remember, last: lastResult, retest, status, probeCodec }
}
