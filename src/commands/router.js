/**
 * 命令路由。
 *
 * ⚠️ 核心约束：命令流量与角色扮演上下文彻底隔离。
 *  - 以 / 开头、菜单数字、粘贴 JSON、载体图片 → 命令/导入路径，不写入会话历史
 *  - 其余 → 聊天路径：写入当前会话 history，组装 system(人设)+system(世界书)+历史 交给模型
 */
import fs from 'node:fs'
import path from 'node:path'
import { downloadMedia, toDataUrl } from '../channel/media.js'
import { previewImport, diffConfig, formatDiff, DOUBLE_CONFIRM_KINDS } from '../import/importer.js'
import { getCurrentCharacter } from '../roleplay/character.js'
import { buildRoleplayMessages, attachMemoryTail, attachHandyBlock, attachTailBlock, attachVoiceNote, stripInjectedTags, MEMORY_PLACEMENT } from '../roleplay/context.js'
import { toExtractText, messageFingerprint, lastIndexMatching } from '../chat/history.js'
import { extractText as extractCarrier } from '../util/carrier.js'
import { takeFor } from '../util/outbox.js'
import { DEFAULT_SYSTEM } from '../prompts/index.js'
import { effectiveMaxTokens } from '../providers/catalog.js'

const IMG_PLACEHOLDER = '[图片]'
const VOICE_PLACEHOLDER = '[语音]'

/**
 * 写进会话历史的那一行（载体给个标记，便于以后回看时分辨）。
 * 图片沿用原来的 `[图片] <正文>`；语音是 `[语音] <转写>`；两者都有就依次列出。
 * 注意：标记只进**历史**，不改变这一轮真正发给模型的内容（那个是 `userText`）。
 */
export function inboundPlaceholder({ hasImages, text, voiceText }) {
  const real = String(text || '').trim()
  const marks = []
  if (hasImages) marks.push(IMG_PLACEHOLDER)
  if (voiceText) marks.push(VOICE_PLACEHOLDER)
  if (!marks.length) return real
  const body = voiceText ? (real ? real + ' ' + voiceText : voiceText) : real
  return body ? marks.join(' ') + ' ' + body : marks.join(' ')
}

/**
 * 语音转写的尾插说明（挂在用户输入之后，与感知/记忆同一处）。
 *
 * 为什么必须说这一句：转写是**机器的理解**，会有错别字、也丢掉了语气与停顿。
 * 不说的话她可能把「没吃饭」当成「吃饭了」照字面接、甚至把错别字当成对方的口头习惯；
 * 同时要讲明「不要拿这个去追问」，否则她会每轮都问「你刚刚是不是说错了」。
 */
export const VOICE_NOTE =
  '对方这条是**语音**，下面是机器转写的文字：可能有错别字，语气和停顿也丢了。按他本来想说的意思理解就行，不用逐字复述转写，也不要拿错别字去跟他确认。'

/**
 * 语音里出现不止一个说话人时补的一句（声学判定出来的事实，不是推测）。
 * 为什么值得说：1:1 聊天里出现第二个人，意味着这条可能是转发的、或者他旁边有人在说话——
 * 不提醒的话她容易把**旁边那个人的话**当真对方在跟她说。
 */
export const MULTI_SPEAKER_NOTE =
  '另外，这条语音里出现了不止一个说话人（可能是转发过来的，也可能他旁边有人在说）：别把另一个人的话当成他在跟你说。'

/** 语音的尾块说明该写什么（纯函数，便于自检直接断言） */
export function voiceNoteText({ multiSpeaker } = {}) {
  return multiSpeaker ? VOICE_NOTE + ' ' + MULTI_SPEAKER_NOTE : VOICE_NOTE
}

/**
 * 验证模式（probe）的回执文案（纯函数，便于自检钉住：上线第一版在此踩了一次「人数没打出来」）。
 *
 * 规则：**只在真的数出人数时才提**（数不出来就不说，不猜）；拿到 1 也说 1 ——
 * 这是验证通道，得能看出「判定确实跑了」；正式模式（chat）则只在 >1 人时才说那一句。
 */
export function probeReplyText({ text, format, sampleRate, ms, attempts, model, speakers } = {}) {
  const bits = []
  if (format) bits.push(format + (sampleRate ? ' ' + sampleRate + 'Hz' : ''))
  if (ms) bits.push(ms + 'ms')
  if (attempts > 1) bits.push('试了' + attempts + '个采样率')
  if (Number(speakers) > 0) bits.push(speakers + ' 人说话')
  if (model) bits.push(model)
  bits.push('不进对话')
  return '【语音识别测试】' + text + '　（' + bits.join(' · ') + '）'
}

/**
 * 对方是不是在「明确要求记住」。
 *
 * 为什么要单独认这个：这类请求不能等周期、也不该被长度阈值挡掉——
 * 明确要求就是「你记着 xx」，拖到 6 轮后、或者因为字数不够被丢都不可以。
 * 模型那边有 `remember` 工具，但**工具调用是模型的自主选择、有随机性**
 * （同一句话两次结果不同：一次记了、一次只回「……嗯」），
 * 所以这里再加一道**不依赖模型**的兜底：命中就当场抽一次，并把阈值调低。
 *
 * 排除「我记着/我记住了」（那是对方在说自己），所以用后顾断言把他们挡掉。
 */
export function looksLikeRememberRequest(text) {
  return /(?<!我)(记着|记住|记一下|记下|帮我记)|别忘了?|不要忘/.test(String(text || ''))
}

export function createRouter({ services }) {
  const byName = new Map()

  function register(cmd) {
    if (!cmd || !cmd.name) return
    byName.set(cmd.name, cmd)
    const aliases = cmd.aliases || []
    for (const alias of aliases) byName.set(alias, cmd)
  }

  function list() {
    return [...new Set([...byName.values()])]
  }

  /** 命令分发（不触碰会话历史） */
  async function dispatch(inbound, text, context) {
    const parts = text.slice(1).split(/\s+/)
    const rawName = parts[0]
    const args = parts.slice(1)
    const name = rawName.toLowerCase()
    const cmd = byName.get(name)
    const merged = { ...services, ...context }
    if (!cmd) {
      await context.reply('未知命令：/' + rawName + '\n发送 /help 查看可用命令。')
      return
    }
    try {
      await cmd.run({ inbound, args, services: merged })
    } catch (err) {
      services.logger.error('命令 /' + name + ' 执行失败：', err.message)
      await context.reply('⚠️ 命令执行失败：' + err.message)
    }
  }

  /** 下载入站图片（一次下载，供载体识别与多模态复用），并留档到 data/inbox */
  async function downloadImages(images) {
    const out = []
    for (const img of images) {
      services.logger.info('正在下载图片…')
      const d = await downloadMedia(img.media, { imageAesKeyHex: img.aeskey, logger: services.logger })
      services.logger.info('图片下载完成 mime=' + d.mime + ' bytes=' + d.bytes)
      try {
        const dir = path.join(services.dataDir || 'data', 'inbox')
        fs.mkdirSync(dir, { recursive: true })
        const ext = d.mime === 'image/png' ? 'png' : d.mime === 'image/gif' ? 'gif' : 'jpg'
        const file = path.join(dir, 'in-' + Date.now() + '.' + ext)
        fs.writeFileSync(file, d.buffer)
        services.store.set('lastInboundImage', file)
        services.logger.info('入站图片已留档：' + file)
      } catch (e) {
        services.logger.warn('留档入站图片失败：', e.message)
      }
      out.push(d)
    }
    return out
  }

  /** 预览并暂存待导入数据 */
  async function stageImport(inbound, obj, context) {
    const p = previewImport(obj)
    if (p.kind === 'unknown') {
      await context.reply('⚠️ 无法识别的 JSON 结构。支持：角色扮演快照（roleplay-snapshot）、角色卡（Character Card）。')
      return false
    }
    if (p.unsupported) {
      await context.reply('暂不支持导入：' + p.label)
      return false
    }
    // 会改动全局配置的类型属于破坏性操作（覆盖系统设置 / Provider），标记二次确认
    const needsDoubleConfirm = DOUBLE_CONFIRM_KINDS.includes(p.kind)
    services.sessions.set(inbound.userId, {
      pendingImport: obj,
      pendingKind: p.kind,
      importConfirmed: false
    })
    const cnt = p.counts || {}
    const parts = Object.keys(cnt).map((k) => k + ' ' + cnt[k])
    const lines = ['检测到可导入内容：', '· 类型：' + p.label, '· ' + (parts.join(' / ') || '（无内容）')]
    if (p.preview && p.preview.characters && p.preview.characters.length) lines.push('· 角色：' + p.preview.characters.join('、'))
    // 设置类：先把「旧值 → 新值」摆出来，避免误覆盖（导入前不看 diff 就等于盲写）
    if (p.kind === 'settings' && obj.config) {
      const changes = diffConfig(services.configStore.get(), obj.config)
      lines.push('', '将变更 ' + changes.length + ' 项系统设置：')
      lines.push(...(changes.length ? formatDiff(changes) : ['（无变化）']))
    }
    lines.push('')
    // 记忆提醒：导入一张角色卡不会清记忆；但导入自带记忆的快照时，replace 会清空现有记忆。
    // （之前没有这条提示，用户重新导入一次角色卡就把累积的记忆清了，且不可恢复）
    if ((p.kind === 'roleplay-snapshot' || p.kind === 'character-card') && services.memory) {
      const mine = services.memory.count(inbound.userId)
      if (mine > 0) {
        const incoming = (p.counts && p.counts.memories) || 0
        lines.push(
          incoming > 0
            ? `⚠️ 你现有 ${mine} 条记忆；该文件自带 ${incoming} 条，用 /import replace 会清空你现有的记忆。`
            : `· 该文件不含记忆，你现有的 ${mine} 条记忆会被保留（不会被清空）。`
        )
      }
    }
    // 会话类：说明它只是「历史」+「会补记忆」。导出文件里**不含记忆**这件事必须讲清楚，
    // 否则对方会以为导入完记忆就回来了（记忆是聊出来的累积状态，只能从正文重抽）。
    if (p.kind === 'session') {
      lines.push(
        '· 导入后会切换到这个会话，并**自动从正文补记忆**（导出文件里不含记忆）',
        '· 补出来的记忆只属于这个会话（记忆默认按会话隔离；要跨会话先 /mem global all）',
        '· 会话名：' + ((p.session && p.session.name) || '导入会话')
      )
    }
    if (needsDoubleConfirm) {
      lines.push('⚠️ 该导入会写入全局系统设置/Provider，需二次确认：')
      lines.push('回复 /import confirm 查看确认清单 → 再回复一次 /import confirm 才会写入；/import cancel 取消。')
    } else {
      lines.push('回复 /import confirm 合并导入，/import replace 覆盖导入，/import cancel 取消')
    }
    await context.reply(lines.join('\n'))
    return true
  }

  /**
   * 自动记忆抽取（异步，不阻塞回复）。
   *
   * 成本控制（P7）：
   *  - 只抽「上次抽取水位线之后」新增的消息，不再把最后 12 条反复送去抽
   *  - 文本长度由 extractMinChars / maxExtractChars 把关（见 memory.extractFromConversation）
   *  - 失败只记日志，绝不影响回复；外层包 try 避免抛回 handleChat 的 catch 把回复改成报错
   */
  function scheduleMemoryExtract({ character, userId, sid, memCfg, force = false }) {
    const every = memCfg.autoExtractEvery || 0
    if (!character || !services.memory || every <= 0) return
    try {
      const ck = 'memTurn:' + userId + ':' + sid
      const n = (services.store.get(ck, 0) || 0) + 1
      services.store.set(ck, n)
      // force = 本轮对方**明确要求记住**（见 looksLikeRememberRequest）：不等周期，当场抽
      if (!force && n % every !== 0) return
      const all = services.history.list(userId, sid)
      // 水位线记「最后抽到的那条消息的指纹」，**绝不能用 all.length**。
      //
      // 需要避免的问题：历史是 40 条滑窗
      // （chat/history.js 的 MAX_TURNS=40），窗口满之后 all.length 恒为 40，
      // 而水位线记的正是 all.length → `all.slice(mark)` 从此永远是空的 0 条，
      // 日志里只剩「无新增消息，跳过自动抽取」，**抽取永久停摆**。
      // 实际运行中：10:35 之后再没有任何一条记忆入库（「无新增」19 次），
      // 用户那三天教的东西（含「以后回复先发文字再带图」）全部没进记忆 ——
      // 表现就是「教了也学不会」，因为**根本没记住**。
      //
      // 水位线记录最后处理的消息，而不是已处理的消息数量。
      const wmKey = 'memSeen:' + userId + ':' + sid
      const seen = services.store.get(wmKey, null)
      let fresh = all
      if (seen) {
        const idx = lastIndexMatching(all, seen)
        // 找不到（那条已被滑窗挤掉）→ 整个窗口都当新的：
        // 宁可重抽一遍（重复会被 0.86 去重与模型判断挡下），也不能漏。
        fresh = idx >= 0 ? all.slice(idx + 1) : all
      }
      if (!fresh.length) {
        services.logger.info('[mem] 无新增消息，跳过自动抽取')
        return
      }
      const maxChars = memCfg.maxExtractChars ?? 4000
      // ⚠️ 必须先把**真实时间**拼进给抽取器的文本，否则它看不到任何时间信息，
      // 只能靠正文猜——曾写出过「凌晨一点多」这种无从核实的时间。
      // 时间不可信的消息（从旧客户端导入、源文件没带时间）不会被加上前缀。
      const { text: conv, from, to } = toExtractText(fresh, { maxChars })
      // ⚠️ 水位线必须**在确认要抽之后**才推进。
      //
      // 需要避免的问题：原来这行写在调用抽取之前，而抽取内部还有一道
      // extractMinChars（默认 200 字）闸门。于是短句聊天时会出现
      // 「增量不到 200 字 → 抽取被跳过 → 但水位线已经推进」= 这批消息**永远抽不到**。
      // 日志上的表现最坑人：一直只有「记忆抽取跳过」，再也不出现「自动新增」，
      // 看起来像抽取功能坏了，实际是消息被静默消费掉了。
      //
      // 现在的语义：长度不够就**什么都不做**，留到下次连着新消息一起抽
      // （尾部仍受 maxExtractChars 截断，不会无限增长）。
      // force 时阈值调低（否则「你记着 xx」这句太短，会被自己的阈值挡在门外）。
      const minChars = force
        ? (memCfg.extractMinCharsOnDemand ?? 20)
        : (memCfg.extractMinChars ?? 200)
      if (conv.length < minChars) {
        services.logger.info(
          `[mem] 增量仅 ${conv.length} 字 < 阈值 ${minChars} 字，本轮跳过（不推进水位线，攒够再抽）`
        )
        return
      }
      // 抽完才推进水位线，而且推到**真正送进去的最后一条**（toExtractText 只裁头不裁尾，
      // 所以 fresh 的最后一条一定在文本里）。这样即使中途失败，下一轮还能接着抽。
      services.store.set(wmKey, messageFingerprint(fresh[fresh.length - 1]))
      services.memory
        .extractFromConversation(conv, { userId, characterId: character.id, sessionId: sid, character, minChars, sourceFrom: from, sourceTo: to })
        .then((added) => {
          if (added && added.length) services.logger.info('[mem] 自动新增 ' + added.length + ' 条记忆')
        })
        .catch((e) => services.logger.warn('[mem] 自动抽取失败：', e.message))
    } catch (e) {
      services.logger.warn('[mem] 自动抽取调度失败：', e.message)
    }
  }

  /** 入站视频：下载留档（供 /diagvideo 回发，验证视频出站能力） */
  async function handleVideo(inbound, context) {
    const videos = inbound.videos || []
    for (let i = 0; i < videos.length; i++) {
      try {
        services.logger.info(`正在下载视频 ${i + 1}/${videos.length}…`)
        // 与图片同理：hex 形式的 key 在 item 层（video_item.aeskey），不在 media 里，
        // 不传就会得到「媒体缺少有效 AES key」
        const d = await downloadMedia(videos[i].media, {
          imageAesKeyHex: videos[i].aeskey,
          logger: services.logger,
          maxBytes: 30 * 1024 * 1024
        })
        services.logger.info('视频下载完成 mime=' + d.mime + ' bytes=' + d.bytes)
        const dir = path.join(services.dataDir || 'data', 'inbox')
        fs.mkdirSync(dir, { recursive: true })
        const ext = d.mime === 'video/webm' ? 'webm' : 'mp4'
        const file = path.join(dir, 'video-' + Date.now() + '.' + ext)
        fs.writeFileSync(file, d.buffer)
        services.store.set('lastInboundVideo', file)
        await context.reply(`已收到视频（${d.bytes}B，${d.mime}）并留档。\n发送 /diagvideo 可把它原样回发，验证视频出站是否可用。`)
      } catch (e) {
        services.logger.warn('视频处理失败：', e.message)
        await context.reply('⚠️ 视频处理失败：' + e.message)
      }
    }
  }

  /** 图片载体识别：命中则作为配置读取，绝不发给模型 */
  async function tryCarrierImport(inbound, downloaded, context) {
    for (const d of downloaded) {
      const payload = extractCarrier(d.buffer)
      if (!payload) continue
      services.logger.info('检测到图片载体载荷，长度=' + payload.length)
      let obj = null
      try {
        obj = JSON.parse(payload)
      } catch (_) {
        await context.reply('检测到载体载荷，但不是 JSON（长度 ' + payload.length + '）。')
        return true
      }
      await stageImport(inbound, obj, context)
      return true
    }
    return false
  }

  /** 文件处理：下载 → 解析 JSON（.txt 亦可，按内容判断）→ 预览 */
  async function handleFile(inbound, context) {
    const files = inbound.files || []
    for (const f of files) {
      try {
        services.logger.info('收到文件 name=' + (f.file_name || '?') + ' len=' + (f.len || '?'))
        const d = await downloadMedia(f.media, { logger: services.logger, maxBytes: 8 * 1024 * 1024 })
        services.logger.info('文件下载完成 mime=' + d.mime + ' bytes=' + d.bytes)
        let obj = null
        try {
          obj = JSON.parse(d.buffer.toString('utf8'))
        } catch (_) {
          await context.reply('⚠️ 文件内容不是合法 JSON（扩展名不限，.txt 也行，只要内容是 JSON）。')
          continue
        }
        await stageImport(inbound, obj, context)
      } catch (e) {
        services.logger.error('文件处理失败：', e.message)
        await context.reply('⚠️ 文件处理失败：' + e.message)
      }
    }
  }

  /**
   * 她「手边能发的图」清单（每轮直接摆进上下文）。
   *
   * 为什么要这么做：实际运行中带图的轮次比例较低。一个原因是发现成本：模型需要先 `file_list`
   * 看一眼有哪些图、再 `send_file`，而一次闲聊的工具往返上限只有 3 轮，为一张图
   * 多跑一轮不划算，于是干脆只说话。把文件名直接给她，这一步摩擦就没了。
   *
   * 失败一律返回 null（列目录失败绝不能影响回复）。
   */
  function handyImageBlock(userId) {
    try {
      const roots = (services.tools && services.tools.rootsFor && services.tools.rootsFor(userId)) || []
      const names = []
      for (const r of roots) {
        let ents = []
        try {
          ents = fs.readdirSync(r, { withFileTypes: true })
        } catch (_) {
          continue
        }
        for (const e of ents) if (e.isFile() && /\.(jpe?g|png|gif|webp)$/i.test(e.name)) names.push(e.name)
      }
      const uniq = [...new Set(names)]
      if (!uniq.length) return null
      const shown = uniq.slice(0, 12)
      return (
        '现在手边能发的图：' +
        shown.join('、') +
        (uniq.length > shown.length ? '（共 ' + uniq.length + ' 张）' : '') +
        '。想发就直接 send_file（as: image），不用先去 file_list 查'
      )
    } catch (_) {
      return null
    }
  }

  /**
   * 把入站语音转成文字。
   *
   * 为什么必须有这一步：`if (!text)` 分支以前只处理 images/files/videos，
   * **「只有语音没有文字」的消息会被静默丢弃**——对方发语音什么都得不到，比报错更糟。
   * 失败也**不能丢消息**：要把可读的原因回给对方，并把 voice_item 的字段名带进日志/回复
   * 回复中带上 voice_item 的字段名，便于确认实际结构。
   */
  async function transcribeVoices(inbound, context) {
    const voices = inbound.voices || []
    if (!voices.length) return null
    const asr = services.asr
    if (!asr) return { ok: false, reason: '服务端没接语音识别模块' }
    const texts = []
    let speakers = null // 这条（或多条）语音里出现过的最多说话人数（拿不到就是 null，不猜）
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i]
      // 平台自带识别结果时直接用（省一次 ASR，也避免二次转写的误差）
      if (v.text) {
        texts.push(v.text)
        services.logger.info(`语音 ${i + 1}/${voices.length} 自带文字，跳过识别`)
        continue
      }
      try {
        services.logger.info(`正在识别语音 ${i + 1}/${voices.length}…`)
        const d = await downloadMedia(v.media, {
          imageAesKeyHex: v.aeskey,
          logger: services.logger,
          maxBytes: Number(services.config.asr?.maxBytes) || 4 * 1024 * 1024
        })
        const r = await asr.transcribe(d.buffer)
        asr.remember({
          buf: d.buffer,
          bytes: d.bytes,
          format: r.format,
          ok: r.ok,
          text: r.text || null,
          reason: r.reason || null,
          ms: r.ms,
          attempts: r.attempts,
          sampleRate: r.sampleRate,
          model: r.model,
          speakers: r.speakers || null,
          itemFields: v.fields || []
        })
        if (r.ok && r.text) {
          const sp = Number(r.speakers?.count) || 0
          services.logger.info(
            `语音识别完成 ${r.ms}ms ${r.text.length}字（${r.format}${r.sampleRate ? ' ' + r.sampleRate + 'Hz' : ''} 试${r.attempts}次` +
              (sp ? ` · 说话人 ${sp}` : '') +
              '）'
          )
          texts.push(r.text)
          if (sp) speakers = Math.max(speakers || 0, sp)
        } else {
          services.logger.warn('语音识别没成功：' + r.reason)
          return { ok: false, reason: r.reason }
        }
      } catch (e) {
        const why = e.message + '（voice_item 字段：' + (v.fields || []).join(',') + '）'
        services.logger.warn('语音处理失败：' + why)
        return { ok: false, reason: why }
      }
    }
    return texts.length ? { ok: true, text: texts.join('\n'), speakers } : { ok: false, reason: '没识别出内容' }
  }

  /** 语音功能有没有被关掉（`/asr off`）——这是回滚闸门，必须真的拦得住，连「平台自带文字」也不放行 */
  function voiceOff() {
    return !services.asr || services.config.asr?.enabled === false
  }
  function voiceOffReply(context) {
    return context.reply(
      !services.asr ? '（收到语音了，但服务端没接语音识别）' : '（语音识别现在是关的，发文字给我吧）'
    )
  }

  /**
   * 验证模式（`asr.mode='probe'`，用户 要求）：只把识别结果**回传给他看**。
   *
   * 为什么单独一条路而不直接进对话：先把「语音能不能收到、能不能解析、识得准不准」验证干净，
   * 再决定它要不要进角色扮演上下文。这一条**不写历史、不调模型、不进记忆**，
   * 所以怎么试都不会污染对话（一旦写进历史就会被当范例每轮喂回来，那种污染很难收拾）。
   */
  async function handleVoiceProbe(inbound, context) {
    if (voiceOff()) return voiceOffReply(context)
    const r = await transcribeVoices(inbound, context)
    if (!r || !r.ok) {
      return context.reply('【语音识别测试】没听出来：' + ((r && r.reason) || '未知原因') + '（仅验证用，不进对话）')
    }
    const l = services.asr.last() || {}
    // ⚠️ `transcribeVoices` 返回的 speakers 是**数字**（最多几个人），不是对象——
    //    第一版当成对象取 `.count`，于是「人数已经数出来了但回执里看不见」（实际运行中抓到的）
    return context.reply(
      probeReplyText({
        text: r.text,
        format: l.format,
        sampleRate: l.sampleRate,
        ms: l.ms,
        attempts: l.attempts,
        model: l.model,
        speakers: r.speakers
      })
    )
  }

  /** 只有语音、没有文字 → 转写后进对话（probe 模式下改为只回传结果，见上） */
  async function handleVoice(inbound, context) {
    if (voiceOff()) return voiceOffReply(context)
    if ((services.config.asr?.mode || 'probe') !== 'chat') return handleVoiceProbe(inbound, context)
    const r = await transcribeVoices(inbound, context)
    if (!r || !r.ok) {
      return context.reply('（语音没听清：' + ((r && r.reason) || '未知原因') + '）\n再发一遍，或者直接打字都行。')
    }
    return handleChat(inbound, context, {
      voiceText: r.text,
      // 人多提醒默认关（识别人数会误报），只有 /asr diar notify on 时才注入
      multiSpeaker: (r.speakers || 0) > 1 && services.config.asr?.diarize?.notify === true
    })
  }

  /** 聊天处理：只有这里写入会话历史 */
  async function handleChat(inbound, context, extra = {}) {
    const providers = services.providers
    const history = services.history
    const cfg = providers?.active?.()
    const images = inbound.images || []
    // 语音：转写出来的文字就当「他说的话」（记忆召回、工具、「要我记住」的判断全部照旧生效）
    const voiceText = extra.voiceText || ''
    const voiceNote = voiceText ? voiceNoteText({ multiSpeaker: extra.multiSpeaker }) : ''
    const userTextForTurn = inbound.text || voiceText
    const character = getCurrentCharacter(services.store, inbound.userId)
    const session = services.chatSessions.current(inbound.userId)
    const sid = session.id
    services.logger.info(
      '[chat] 进入 handleChat images=' + images.length + ' voice=' + (voiceText ? voiceText.length + '字' : '无') + ' model=' + (cfg?.chatModel || '-') + ' 角色=' + (character ? character.name : '(无)') + ' 会话=' + session.name
    )

    if (!cfg?.apiKey || !cfg?.chatModel) {
      const hint = images.length ? '（已收到图片，但尚未配置模型，无法识别）' : ''
      await context.reply('（echo 模式）' + hint + '你说：' + (userTextForTurn || '(空)') + '\n\n尚未配置模型。用 /provider 查看服务商，/key set <key> 配置密钥后再来。')
      return
    }

    const userText = userTextForTurn
    const placeholder = inboundPlaceholder({ hasImages: images.length > 0, text: inbound.text, voiceText })
    history.append(inbound.userId, sid, 'user', placeholder)
    const prior = history.list(inbound.userId, sid).slice(0, -1)

    try {
      services.logger.info('[chat] 发送输入状态…')
      await context.typing?.()
      services.logger.info('[chat] 输入状态完成')

      const downloaded = images.length ? await downloadImages(images) : []
      if (downloaded.length) {
        const isCarrier = await tryCarrierImport(inbound, downloaded, context)
        if (isCarrier) {
          history.pop(inbound.userId, sid)
          return
        }
        services.logger.info('[chat] 未检测到载体载荷，按普通图片交给模型识别')
      }
      const imgParts = downloaded.length
        ? downloaded.map((d) => ({ type: 'image_url', image_url: { url: toDataUrl(d.buffer, d.mime) } }))
        : null
      const currentContent = imgParts
        ? [{ type: 'text', text: userText || '请描述这张图片。' }, ...imgParts]
        : userText

      const effectiveUserName = session.userName || services.config.roleplay?.userName || '用户'
      const memCfg = services.config.memory || {}
      // 感知（时间等客观事实）：必须在**拼提示词之前**拿到，因为时间得先摆进上下文。
      // 注意取的是 `prior`（不含本轮输入）——「上次说话」要的是上一轮，不是这一轮。
      // 感知失败绝不能影响回复：整段包 try，最坏情况只是这轮少了那几行事实。
      let perceptionText = null
      try {
        const r = services.perception
          ? await services.perception.perceive({ userId: inbound.userId, sessionId: sid, history: prior, now: Date.now() })
          : null
        perceptionText = (r && r.text) || null
        if (perceptionText) {
          services.logger.info('[perc] 注入感知：' + perceptionText.replace(/\n/g, ' ｜ '))
        } else if (r && r.notes && r.notes.length) {
          services.logger.info('[perc] 本轮无感知内容（' + r.notes.join('；') + '）')
        }
      } catch (e) {
        services.logger.warn('[perc] 感知失败（不影响本轮回复）：' + e.message)
      }
      // 记忆摆哪：默认挂在用户输入之后（尾插），'system' 可退回旧行为，见 roleplay/context.js
      const memoryPlacement = memCfg.memoryPlacement === 'system' ? MEMORY_PLACEMENT.SYSTEM : MEMORY_PLACEMENT.TAIL
      let memoryText = null
      let summaryText = null
      if (character) {
        if (memCfg.injectMemories !== false && services.memory && userText) {
          memoryText = await services.memory.recall(userText, { userId: inbound.userId, characterId: character.id, sessionId: sid })
          if (memoryText) services.logger.info('[chat] 注入相关记忆')
        }
        if (memCfg.useSummary !== false && services.summary) {
          const sm = services.summary.latest(inbound.userId, sid)
          if (sm) {
            summaryText = sm.content
            services.logger.info('[chat] 注入前情总结')
          }
        }
      }
      let messages
      if (character) {
        messages = buildRoleplayMessages({
          store: services.store,
          config: services.config,
          character,
          history: prior,
          userText,
          userName: effectiveUserName,
          memoryText,
          summaryText,
          userId: inbound.userId,
          memoryPlacement
        })
        messages.push({ role: 'user', content: currentContent })
        // 感知（时间等）：每轮都变，所以和记忆一样挂在用户输入之后，绝不进 system
        attachTailBlock(messages, perceptionText)
        // 这条是语音转写的：说说清楚，免得她逐字复述错别字（见 VOICE_NOTE）
        if (voiceNote) attachVoiceNote(messages, voiceNote)
        // 相关记忆挂在本轮用户输入之后：保住 system(人设)+世界书+历史 的前缀缓存
        // （放 system 里的话，每轮都变的记忆会把整段历史的缓存全部挤掉）
        if (memoryPlacement === MEMORY_PLACEMENT.TAIL) attachMemoryTail(messages, memoryText)
        // 手边能发的图：省掉一次 file_list 往返（带图率上不去的直接原因之一）
        attachHandyBlock(messages, handyImageBlock(inbound.userId))
      } else {
        messages = [{ role: 'system', content: DEFAULT_SYSTEM }]
        for (const m of prior) messages.push({ role: m.role, content: m.content })
        messages.push({ role: 'user', content: currentContent })
        attachTailBlock(messages, perceptionText)
        if (voiceNote) attachVoiceNote(messages, voiceNote)
      }

      services.logger.info('[chat] 调用模型…')
      const llm = services.config.llm || {}
      const runArgs = {
        messages,
        maxTokens: effectiveMaxTokens(llm.maxTokens, providers.activeId),
        temperature: llm.temperature ?? undefined,
        // 工具里有一类要按用户隔离（recall_memory），得把本轮是谁在说话带下去；
        // 另外把「本轮还能不能发文件」的出口一并带下去（send_file 要用新鲜 context_token）：
        // 主动发（无入站）拿不到 token，所以只能在**本轮**里发，这也是 sent 计数按轮生效的原因。
        userCtx: {
          userId: inbound.userId,
          characterId: character ? character.id : null,
          sessionId: sid,
          contextToken: inbound.contextToken,
          sent: { count: 0 },
          // 工具要能申请延长本轮时限（delegate_task 会用它，否则委托稳定被判超时）
          extendTimeout: context.extendTimeout,
          ...(context.channel
            ? {
                sendFile: (name, buf) => context.channel.sendFile(inbound.userId, buf, name, inbound.contextToken),
                // ⚠️ 签名必须与 send_file 工具的调用一致：它两条通道都按 `fn(name, buf)` 调。
                //    曾经这里是 `(buf) => sendImage(uid, buf, ...)`，于是工具传进来的 **name 被当成图片内容**
                //    上传（「photo.jpg」→ AES 补齐正好 16 字节），CDN 直接 500：
                //    实际表现就是「图片通道从来发不出去、一直退化成文件」（已发送图片 = 0 次）。
                sendImage: (_name, buf) => context.channel.sendImage(inbound.userId, buf, inbound.contextToken)
              }
            : {})
        },
        // 每轮工具往返都刷一次「正在输入」，避免长时间静默让用户以为掉线（不发系统提示，保住角色沉浸感）
        onRound: () => context.typing?.()
      }
      const res = services.agent
        ? await services.agent.run(runArgs)
        : await providers.chat({ messages, maxTokens: runArgs.maxTokens, temperature: runArgs.temperature })
      // ⚠️ 日志要记**模型真正返回的长度**，不是回给用户的文案长度。
      // 曾经出错：原来直接记 replyText.length，占位文案 `（模型未返回内容）` 是 9 字，
      // 于是日志写「模型返回 text=9字」，看着像「模型说了 9 个字」，
      // 按 text=0字 去检索一条都搜不到。
      const modelText = (res && res.text) || ''
      // 注入块（相关记忆 / 感知）是**系统给她的资料**，不是她说的话。
      // 实际运行中：模型把 `<related_memory>` 当正文吐了出来，标记直接发送到了聊天中。
      // 提示词已加禁令（第一道），这里再兕一道——**而且必须先于写历史**：
      // 泄漏的回复一旦进了会话历史，就会被当范例每轮喂回来（自强化），越往后越难收。
      const cleanedText = stripInjectedTags(modelText)
      if (cleanedText !== modelText) {
        services.logger.warn(
          '[chat] 回复里混进了注入块标签，已剥离（原 ' +
            modelText.length +
            ' 字 → ' +
            cleanedText.length +
            ' 字）原文尾部：' +
            JSON.stringify(modelText.slice(-60))
        )
      }
      const replyText = cleanedText || '（模型未返回内容）'
      const reasoning = (res && res.reasoning) || ''
      const trace = (res && res.trace) || []
      if (res && res.mode && res.mode !== 'off') {
        services.logger.info(`[chat] 工具协议=${res.mode} 往返=${res.rounds}${res.capped ? ' 已达上限' : ''}`)
      }
      services.logger.info(
        '[chat] 模型返回 text=' +
          modelText.length +
          '字 思考链=' +
          reasoning.length +
          '字 工具调用=' +
          trace.length +
          '次' +
          (res && res.finishReason ? ' finish=' + res.finishReason : '')
      )
      if (!modelText) {
        services.logger.warn('[chat] 模型未返回内容，已按占位文案回复（providers 那边已催促重试过，仍为空）')
      }
      // token 与**缓存命中**：此前 usage 被直接丢掉，于是「摆位对不对」只能靠推理。
      // 现在每轮落一条，`/usage` 看滚动统计。
      const usages = (res && res.usages) || (res && res.usage ? [res.usage] : [])
      const u = services.usage && services.usage.record(usages, { rounds: res && res.rounds, tools: trace.length })
      if (u) {
        const rate = u.prompt ? Math.round((u.cacheHit / u.prompt) * 100) : null
        services.logger.info(
          `[chat] tokens 输入=${u.prompt} 输出=${u.completion}` +
            (rate == null ? '（该服务商未返回缓存字段）' : `｜缓存命中 ${u.cacheHit}/${u.prompt}（${rate}%）`)
        )
      }
      // 思考链与工具调用链随会话记录（都不参与后续请求上下文，仅用于 /cot 查看与导出审阅）
      const meta = {}
      if (reasoning) meta.reasoning = reasoning
      if (trace.length) meta.tools = trace
      history.append(inbound.userId, sid, 'assistant', replyText, Object.keys(meta).length ? meta : null)

      // 自动记忆抽取（不影响回复，异步进行；只抽增量，见 scheduleMemoryExtract）
      //
      // 「你记着 xx」这类明确要求有**两条**保障，二者互斥：
      //   ① 模型自己调 `remember` 工具（当场写，最准，因为它理解上下文）
      //   ② 兜底：若模型没调，就当场抽一次（不等周期、阈值放宽）
      // 必须互斥——两条都跑会写出**同一个事实的两个版本**（「隆一般六点下班」/「用户一般六点下班」），
      // 措辞不同、余弦到不了去重阈值，就会留下两条重复记忆（实际运行中出现过）。
      const wroteByTool = trace.some((t) => t.name === 'remember' && t.ok)
      scheduleMemoryExtract({
        character,
        userId: inbound.userId,
        sid,
        memCfg,
        force: !wroteByTool && looksLikeRememberRequest(userText)
      })

      await context.typingEnd?.()
      return context.reply(replyText)
    } catch (err) {
      history.pop(inbound.userId, sid)
      await context.typingEnd?.().catch?.(() => {})
      const extra = images.length ? '\n（若当前模型不支持图片，请改用支持视觉的模型，如 deepseek-flash）' : ''
      return context.reply('⚠️ 模型调用失败：' + err.message + extra)
    }
  }

  /** 待发件箱：主动发送需新鲜 context_token，改为在下次入站时补发 */
  async function flushOutbox(inbound, context) {
    const list = takeFor(services.dataDir || 'data', inbound.userId)
    if (!list.length) return
    for (const item of list) {
      try {
        const buf = fs.readFileSync(item.path)
        await context.channel.sendFile(inbound.userId, buf, item.name, inbound.contextToken)
        services.logger.info('outbox 已补发：' + item.name)
      } catch (e) {
        services.logger.warn('outbox 补发失败：' + item.name + ' ' + e.message)
      }
    }
  }

  async function handle(inbound, opts) {
    // 通道把「认不出来的媒体」交上来时，回一句可读的话（而不是什么都不发生）。
    // 协议形状我们没全掌握，这句话 + 日志里的字段名就是下一步改代码的依据。
    if (inbound.unknownItems && !inbound.text && !(inbound.images || []).length && !(inbound.voices || []).length && !(inbound.files || []).length && !(inbound.videos || []).length) {
      return opts.reply?.('（这条媒体系我这边还解不出来：' + inbound.unknownItems + ' —— 已记进日志，等我看一眼）')
    }
    const context = { ...opts }
    try {
      await flushOutbox(inbound, context)
    } catch (_) {
      /* 补发失败不影响正常流程 */
    }
    const text = (inbound.text || '').trim()
    const hasImages = (inbound.images || []).length > 0
    const hasFiles = (inbound.files || []).length > 0
    const hasVoices = (inbound.voices || []).length > 0
    const hasVideos = (inbound.videos || []).length > 0

    if (!text) {
      if (hasImages) return handleChat(inbound, context)
      if (hasFiles) return handleFile(inbound, context)
      // 语音放在视频前面：视频目前只做留档，语音是真的能变成「他说的话」
      if (hasVoices) return handleVoice(inbound, context)
      if (hasVideos) return handleVideo(inbound, context)
      return
    }

    // 菜单数字选择 → 命令路径
    if (/^\d+$/.test(text)) {
      const s = services.sessions?.get(inbound.userId)
      const opt = s && s.options ? s.options[Number(text) - 1] : null
      if (opt) {
        services.sessions.clear(inbound.userId)
        return dispatch(inbound, opt.cmd, context)
      }
    }

    // 斜杠命令
    if (text.startsWith('/')) return dispatch(inbound, text, context)

    // 直接粘贴 JSON → 导入路径（不进入角色扮演上下文）
    const first = text[0]
    if (first === '{' || first === '[') {
      let obj = null
      try {
        obj = JSON.parse(text)
      } catch (_) {
        obj = null
      }
      if (obj) {
        const p = previewImport(obj)
        if (p.kind !== 'unknown' && !p.unsupported) return stageImport(inbound, obj, context)
      }
    }

    // 文字与语音混在同一条（少见）：语音一样要走（probe 模式只回传结果，chat 模式并进这一轮）
    if (hasVoices) {
      if (voiceOff()) {
        await voiceOffReply(context)
        return handleChat(inbound, context)
      }
      if ((services.config.asr?.mode || 'probe') !== 'chat') {
        await handleVoiceProbe(inbound, context)
        return handleChat(inbound, context)
      }
      const r = await transcribeVoices(inbound, context)
      return handleChat(
        inbound,
        context,
        r && r.ok
          ? { voiceText: r.text, multiSpeaker: (r.speakers || 0) > 1 && services.config.asr?.diarize?.notify === true }
          : {}
      )
    }

    return handleChat(inbound, context)
  }

  /**
   * 主动消息：**没有任何入站消息**时发起一轮。
   *
   * 为什么不另写一套：这一轮和人正常找她聊**完全一样**——人设 + 世界书 + 历史 + 相关记忆 +
   * 感知（这样她才知道「隔了多久」）+ 工具（所以也可以顺手发张图）。差别只有三处：
   *   ① 没有用户消息 → 末尾挂一段「系统提示：没人跟你说话，你可以主动开口」的尾块；
   *   ② 发送凭证不吃本轮的 context_token，而是 `channel.lastTokenFor()`（落盘的最后一次）；
   *   ③ 写历史时**只写她那句**（历史里没有「用户说过话」这回事，效果就是「她自己来说了一句」）。
   *
   * 失败**绝不谎报**：抛错/空话就返回 { ok:false }；文案发不出去时 `sendReply` 自己会落待发队列
   * （下次入站补发），这条路径与正常回复共用同一套收敛规则。
   */
  async function initiateTurn(userId, { channel, hint = null, trigger = 'scheduler' } = {}) {
    const providers = services.providers
    const cfg = providers?.active?.()
    if (!userId) return { ok: false, reason: '没有对象' }
    if (!cfg?.apiKey || !cfg?.chatModel) return { ok: false, reason: '尚未配置模型' }
    const character = getCurrentCharacter(services.store, userId)
    const session = services.chatSessions.current(userId)
    const sid = session.id
    const prior = services.history.list(userId, sid)
    if (!prior.length) return { ok: false, reason: '还没有聊过（怕突然说话吓到人，先等对方开口）' }
    const token = (channel && channel.lastTokenFor && channel.lastTokenFor(userId)) || null

    services.logger.info('[proactive] 发起一轮（' + trigger + '）：角色=' + (character ? character.name : '(无)') + ' 历史=' + prior.length + ' 条 token=' + (token ? '有' : '无'))
    try {
      const memCfg = services.config.memory || {}
      const effectiveUserName = session.userName || services.config.roleplay?.userName || '用户'
      // 感知：主动开口时尤其需要「距上次说话多久」——她得知道自己隔了多久才开口
      let perceptionText = null
      try {
        const r = services.perception
          ? await services.perception.perceive({ userId, sessionId: sid, history: prior, now: Date.now() })
          : null
        perceptionText = (r && r.text) || null
        if (perceptionText) services.logger.info('[proactive] 注入感知：' + perceptionText.replace(/\n/g, ' ｜ '))
      } catch (e) {
        services.logger.warn('[proactive] 感知失败（不影响开口）：' + e.message)
      }
      const memoryPlacement = memCfg.memoryPlacement === 'system' ? MEMORY_PLACEMENT.SYSTEM : MEMORY_PLACEMENT.TAIL
      let memoryText = null
      if (character && memCfg.injectMemories !== false && services.memory) {
        memoryText = await services.memory.recall(hint || '一个人待着，想起对方', {
          userId,
          characterId: character.id,
          sessionId: sid
        })
        if (memoryText) services.logger.info('[proactive] 注入相关记忆')
      }
      const summaryText =
        memCfg.useSummary !== false && services.summary
          ? (services.summary.latest(userId, sid)?.content || null)
          : null
      const messages = buildRoleplayMessages({
        store: services.store,
        config: services.config,
        character,
        history: prior,
        userText: '',
        userName: effectiveUserName,
        memoryText,
        summaryText,
        userId,
        memoryPlacement
      })
      // ⚠️ 这一轮**必须**以一条 user 消息收尾（实际运行中出现过，）：
      //   ① 思考模式 + 工具协议要求最后一条是 user，否则直接 400：
      //      「The `reasoning_content` in the thinking mode must be passed back to the API」
      //      （第一次真实触发就是这么失败的，一句话都没发出去）
      //   ② 尾插块（感知 / 记忆 / 手边图 / 底下这条提示）**只挂在「本轮用户输入之后」**，
      //      没有 user 消息时它们会**静默消失** —— 少一个角色都不知道自己为什么开口、
      //      也不知道手边有哪些图。
      // 内容本身是系统提示（带可剥离的标签）：提示词已写明「资料块不是你说话的一部分」，
      // 万一模型把它吐出来，出口的 stripInjectedTags 会连内容一起剥。
      messages.push({
        role: 'user',
        content: '<proactive_note>【系统提示（不是对方说的话）】现在没有人跟你说话——这是你自己想开口的时候。</proactive_note>'
      })
      attachTailBlock(messages, perceptionText)
      if (memoryPlacement === MEMORY_PLACEMENT.TAIL) attachMemoryTail(messages, memoryText)
      attachHandyBlock(messages, handyImageBlock(userId))
      attachTailBlock(
        messages,
        '【系统提示（不是对方说的话）】你一个人待着，突然想起他，于是主动开口说一两句。' +
          '要求：像真人随口发来的那样自然；不要问「在吗」「在忙吗」这种空话，' +
          '不要解释你为什么突然说话，也不要提到这条提示。' +
          (hint ? '（可以顺着这个念头说：' + hint + '）' : '')
      )

      const llm = services.config.llm || {}
      const res = await services.agent.run({
        messages,
        maxTokens: effectiveMaxTokens(llm.maxTokens, providers.activeId),
        temperature: llm.temperature ?? undefined,
        userCtx: {
          userId,
          characterId: character ? character.id : null,
          sessionId: sid,
          contextToken: token,
          sent: { count: 0 },
          ...(channel
            ? {
                sendFile: (name, buf) => channel.sendFile(userId, buf, name, token),
                sendImage: (_name, buf) => channel.sendImage(userId, buf, token)
              }
            : {})
        },
        onRound: () => channel?.sendTyping?.(userId, token, 1)
      })
      const modelText = (res && res.text) || ''
      const cleaned = stripInjectedTags(modelText)
      if (!cleaned) return { ok: false, reason: '模型没说出来话（' + (modelText ? '只剩标记' : '空回复') + '）' }
      const meta = {}
      if (res && res.reasoning) meta.reasoning = res.reasoning
      if (res && res.trace && res.trace.length) meta.tools = res.trace
      // 只写她那句：历史里不出现「用户说过话」，效果就是她自己来说了一句
      services.history.append(userId, sid, 'assistant', cleaned, Object.keys(meta).length ? meta : null)
      if (channel) await channel.sendReply(userId, cleaned, token)
      services.logger.info('[proactive] 已开口（' + trigger + '）：' + cleaned.replace(/\s+/g, ' ').slice(0, 60))
      return { ok: true, text: cleaned }
    } catch (e) {
      services.logger.warn('[proactive] 发起失败（不影响正常回复）：' + e.message)
      return { ok: false, reason: e.message }
    }
  }

  return { register, list, handle, initiateTurn }
}
