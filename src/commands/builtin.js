/**
 * 内置基础命令。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { scopedCollection, ownershipStats } from '../storage/scope.js'
import { readPending } from '../channel/pending.js'
import { outputTokenLimit } from '../providers/catalog.js'

export function registerBuiltin(router) {
  router.register({
    name: 'help',
    aliases: ['h', '?'],
    description: '查看帮助',
    run: async ({ services }) => {
      const lines = router.list().map((c) => `/${c.name}　${c.description || ''}`)
      await services.reply(['可用命令：', ...lines, '', '直接发消息即与模型对话；回复 /menu 打开菜单。'].join('\n'))
    }
  })

  router.register({
    name: 'ping',
    description: '连通性测试',
    run: async ({ services }) => services.reply('pong 🏓')
  })

  router.register({
    name: 'usage',
    aliases: ['cost', 'token'],
    description: '查看 token 开销与缓存命中率',
    run: async ({ args, services }) => {
      const meter = services.usage
      if (!meter) return services.reply('用量计未启用。')
      if ((args[0] || '').toLowerCase() === 'reset') {
        meter.clear()
        return services.reply('用量统计已清空。')
      }
      const s = meter.stats()
      const w = s.window
      if (!w.rounds) return services.reply('还没有用量记录。发几轮对话后再看。')
      const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-')
      const lines = [
        '用量（最近 ' + w.rounds + ' 轮，累计 ' + s.totals.rounds + ' 轮）',
        '· 输入 tokens：' + w.prompt + '　输出 tokens：' + w.completion,
        '· 缓存命中：' + w.cacheHit + '/' + w.prompt + '（' + pct(w.cacheHit, w.prompt) + '）',
        '· 未命中：' + w.cacheMiss,
        '· 平均每轮：输入 ' + Math.round(w.prompt / w.rounds) + ' · 输出 ' + Math.round(w.completion / w.rounds) + ' · 调用 ' + (w.calls / w.rounds).toFixed(1) + ' 次',
        '· 调用次数：' + w.calls + '（多于轮数说明发生了工具往返）'
      ]
      if (!w.cached) {
        lines.push('', '⚠️ 该服务商没有返回缓存字段，命中率无从计算（不是 0%）。')
      } else {
        lines.push(
          '',
          '怎么读：命中率低通常是**前缀不稳定**——每轮都变的内容（相关记忆、世界书命中项）',
          '一旦插在历史之前，就会把后面的历史全挤出缓存。相关记忆已挪到用户输入之后（memoryPlacement）。',
          '清空统计：/usage reset'
        )
      }
      return services.reply(lines.join('\n'))
    }
  })

  router.register({
    name: 'status',
    description: '查看运行状态',
    run: async ({ inbound, services }) => {
      const { channel, config, store, providers } = services
      const cfg = providers?.active?.()
      const uid = inbound.userId
      const stats = ownershipStats(store, uid)
      const visible = (name) => scopedCollection(store, name, uid).list().length
      const lim = channel && channel.limiter ? channel.limiter.stats() : null
      // 向量模型要看「解析后的向量配置」，而不是当前对话 Provider 的 embedModel：
      // 两者可以不同源（默认对话走 deepseek、向量走硅基流动），
      // 旧实现会错报「向量模型：(未配置)」
      const emb = services.embedder?.info?.() || null
      const embLine = emb && emb.model ? emb.model + '（' + emb.providerId + (emb.apiKey ? '' : '，缺 Key') + '）' : '(未配置)'
      const lines = [
        '运行状态',
        `· 通道：${channel?.running ? '运行中' : '已停止'}`,
        `· Provider：${providers?.activeId || '-'}`,
        `· 模型：${cfg?.chatModel || '(未配置)'}`,
        `· Key：${cfg?.apiKey ? '已配置' : '未配置'}`,
        `· 向量模型：${embLine}`,
        `· 角色卡：${visible('characters')} 张（自有 ${stats.characters.own} / 共享 ${stats.characters.shared} / 其他用户 ${stats.characters.others}）`,
        `· 世界书：${visible('lorebook')} 条（自有 ${stats.lorebook.own} / 共享 ${stats.lorebook.shared}）`,
        `· 记忆：${visible('memories')} 条（自有 ${stats.memories.own} / 共享 ${stats.memories.shared}）`
      ]
      if (lim) lines.push(`· 发送限流：额度 ${lim.quota}/${lim.maxPerWindow} · 窗口已用 ${lim.used} · 冷却 ${Math.round(lim.cooldownMs / 1000)}s`)
      const pq = channel?.pendingStats?.()
      if (pq && pq.count) {
        const mins = pq.oldestAt ? Math.round((Date.now() - pq.oldestAt) / 60000) : 0
        lines.push(`· 待发队列：${pq.count} 条（${pq.chars} 字，最旧 ${mins} 分钟前）`)
      }
      await services.reply(lines.join('\n'))
    }
  })

  router.register({
    name: 'pending',
    description: '查看待发队列 / pending retry 立即补发',
    run: async ({ args, services }) => {
      const { channel } = services
      if (!channel?.pendingStats) return services.reply('当前没有通道，待发队列不适用。')
      const before = channel.pendingStats()
      if (!before.count) return services.reply('待发队列是空的（所有内容都已送出）。')
      if (String(args || '').trim() === 'retry') {
        const r = await channel.drainPending()
        const after = channel.pendingStats()
        return services.reply(`补发：成功 ${r.sent} 条，剩余 ${after.count} 条。` + (after.count ? '（仍失败多为微信侧限流，稍后会自动重试）' : ''))
      }
      const list = readPending(services.dataDir).slice(0, 3)
      const preview = list.map((x, i) => `${i + 1}. ${String(x.text).slice(0, 40)}${String(x.text).length > 40 ? '…' : ''}`)
      await services.reply(['待发队列：' + before.count + ' 条 / ' + before.chars + ' 字', ...preview, '', '发 /pending retry 立即补发（平时会自动补发）'].join('\n'))
    }
  })

  router.register({
    name: 'cancel',
    description: '取消当前操作',
    run: async ({ inbound, services }) => {
      services.sessions?.clear(inbound.userId)
      await services.reply('已取消。')
    }
  })

  router.register({
    name: 'reset',
    aliases: ['clear'],
    description: '清空当前对话上下文（不影响命令与配置）',
    run: async ({ inbound, services }) => {
      const s = services.chatSessions.current(inbound.userId)
      services.history.clear(inbound.userId, s.id)
      await services.reply('已清空当前会话「' + s.name + '」的上下文（不影响其他会话与配置）。')
    }
  })

  router.register({
    name: 'context',
    aliases: ['ctx'],
    description: '查看当前对话上下文',
    run: async ({ inbound, services }) => {
      const s = services.chatSessions.current(inbound.userId)
      const n = services.history.size(inbound.userId, s.id)
      const turns = Math.ceil(n / 2)
      await services.reply('会话「' + s.name + '」：' + n + ' 条消息（约 ' + turns + ' 轮）。命令不进入上下文。')
    }
  })

  router.register({
    name: 'cot',
    aliases: ['think', 'chain', 'trace'],
    description: '查看思维链与工具调用链：/cot [轮数|all]',
    run: async ({ args, services, inbound }) => {
      const { reply } = services
      const session = services.chatSessions.current(inbound.userId)
      const all = services.history.list(inbound.userId, session.id)

      const clock = (t) => (t ? new Date(t).toTimeString().slice(0, 8) : '--:--:--')
      const clip = (s, n) => {
        const str = String(s == null ? '' : s).replace(/\n/g, ' ')
        return str.length > n ? str.slice(0, n) + '…' : str
      }
      const hasContent = (m) => Boolean(m.reasoning) || (Array.isArray(m.tools) && m.tools.length > 0)

      // 所有助手轮次（不过滤），以及其中「真的有东西」的
      const allTurns = []
      all.forEach((m, i) => {
        if (m.role === 'assistant') allTurns.push({ i, m })
      })
      if (!allTurns.length) return reply('本会话还没有助手回复。')

      const recorded = allTurns.filter(({ m }) => hasContent(m))
      if (!recorded.length) {
        return reply(
          '本会话还没有任何一轮留下思维链或工具调用。\n' +
            '· 思维链：思考模式开启（/thinking），且该轮确实产生了思考内容\n' +
            '· 工具调用链：该轮真的调用过工具（见 /tools）\n' +
            '这两样不是每轮都有——简单的寒暄往往既不想、也不调工具。'
        )
      }

      const arg = String(args[0] || '').toLowerCase()
      let pick
      let notice = ''
      if (arg === 'all') {
        pick = recorded
      } else if (arg) {
        const n = Number(arg)
        if (!Number.isFinite(n) || n < 1) return reply('用法：/cot [轮数|all]（默认最近 1 轮）')
        pick = allTurns.slice(-Math.min(n, allTurns.length))
      } else {
        // 默认 = 最近一轮。若最近一轮既没思维链也没调工具，必须明说，
        // 否则用户会以为命令坏了（之前就是静默回退到更早的一轮，看着像没反应）。
        const last = allTurns[allTurns.length - 1]
        if (hasContent(last.m)) {
          pick = [last]
        } else {
          pick = [last, recorded[recorded.length - 1]]
          notice = '最近一轮（' + clock(last.m.at) + '）没有思维链，也没有调用工具。下面是最近一条有记录的轮次。'
        }
      }

      const blocks = []
      for (const { i, m } of pick) {
        const tools = Array.isArray(m.tools) ? m.tools : []
        const lines = ['—— ' + clock(m.at) + ' ——']
        const q = i > 0 && all[i - 1] && all[i - 1].role === 'user' ? all[i - 1].content : ''
        if (q) lines.push('你：' + clip(q, 60))

        // 固定三段：思维链 → 工具链 → 原文（没有的段落显式写「（无）」，保持结构可预期）
        lines.push('', '【思维链】')
        lines.push(m.reasoning ? String(m.reasoning).trim() : '（无）')

        lines.push('', '【工具链】')
        if (tools.length) {
          tools.forEach((t, k) => {
            lines.push(
              (k + 1) + '. ' + t.name + '　' + (t.ok ? 'ok' : '失败') +
                '　' + (t.ms ?? '?') + 'ms　返回 ' + (t.chars ?? 0) + ' 字'
            )
            const a = JSON.stringify(t.args || {})
            if (a && a !== '{}') lines.push('   args: ' + a)
            if (t.preview) lines.push('   → ' + clip(t.preview, 400))
          })
        } else {
          lines.push('（无）')
        }

        lines.push('', '【原文】')
        lines.push(m.content ? String(m.content).trim() : '（空）')
        blocks.push(lines.join('\n'))
      }

      const body = (notice ? notice + '\n\n' : '') + blocks.join('\n\n')
      // 用 sendRaw 而不是 reply：思维链里的换行若走语义分段会变成几十条消息刷屏
      if (services.channel && typeof services.channel.sendRaw === 'function') {
        await services.channel.sendRaw(inbound.userId, body, inbound.contextToken)
      } else {
        await reply(body)
      }
    }
  })

  router.register({
    name: 'max',
    aliases: ['limit', 'maxtokens'],
    description: '模型生成上限：/max 查看 ｜ /max reply|extract|summary <n|max> ｜ /max all',
    run: async ({ args, services }) => {
      const { configStore, reply, providers } = services
      const providerId = providers ? providers.activeId : null
      const lim = providers ? outputTokenLimit(providerId) : null
      const model = (providers && providers.active && providers.active()?.chatModel) || '-'
      // ⚠️ configStore.set 是「原地更新 this.data，但换掉子对象」——所以每次现读 services.config，
      // 别在开头把 config.llm 缓存下来（缓存的那个引用在 set 之后就过期了）。
      const read = () => ({
        reply: services.config.llm ? services.config.llm.maxTokens : null,
        extract: (services.config.memory || {}).extractMaxTokens,
        summary: (services.config.memory || {}).summaryMaxTokens
      })
      const fmt = (v) => {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return '跟随模型上限' + (lim ? `（${lim}）` : '')
        return String(n) + (lim && n > lim ? `（⚠️ 超过模型上限，实际会被夹到 ${lim}）` : '')
      }
      const LABEL = { reply: '回复上限', extract: '记忆抽取上限', summary: '剧情总结上限' }

      const [sub, val] = args
      if (!sub) {
        const v = read()
        return reply(
          [
            `模型生成上限（模型 ${model}｜本服务商上限 ${lim ?? '未知'}）`,
            `· 回复：${fmt(v.reply)}`,
            `· 记忆抽取：${fmt(v.extract)}`,
            `· 剧情总结：${fmt(v.summary)}`,
            '',
            '改：/max reply|extract|summary <数字>；写 max 表示回到「跟随模型上限」',
            '例：/max reply 4000 ｜ /max all',
            '说明：这是**上限不是预留**，用不到不额外花钱，所以默认就放到模型最高值。'
          ].join('\n')
        )
      }

      const target = String(sub).toLowerCase()
      const list = () => {
        const v = read()
        return ['· 回复：' + fmt(v.reply), '· 记忆抽取：' + fmt(v.extract), '· 剧情总结：' + fmt(v.summary)].join('\n')
      }
      if (target === 'all' || target === 'reset' || target === 'max') {
        configStore.set({ llm: { maxTokens: null }, memory: { extractMaxTokens: null, summaryMaxTokens: null } })
        return reply('已把三项都设回「跟随模型上限」' + (lim ? `（${lim}）` : '') + '\n' + list())
      }
      if (!LABEL[target]) {
        return reply('用法：/max ｜ /max reply|extract|summary <数字|max> ｜ /max all')
      }
      const raw = String(val == null ? '' : val).trim().toLowerCase()
      const isFollow = raw === 'max' || raw === '上限' || raw === 'reset'
      const n = isFollow ? null : Number(raw)
      if (!isFollow && (!Number.isFinite(n) || n < 1)) {
        return reply('要一个正整数，或者写 max（跟随模型上限）。例：/max ' + target + ' 4000')
      }
      if (target === 'reply') configStore.set({ llm: { maxTokens: n } })
      else if (target === 'extract') configStore.set({ memory: { extractMaxTokens: n } })
      else configStore.set({ memory: { summaryMaxTokens: n } })
      return reply(LABEL[target] + '：' + fmt(read()[target]))
    }
  })

  router.register({
    name: 'reply',
    aliases: ['seg'],
    description: '分段逐条发送：/reply on|off / delay <毫秒> / tokens <n>（= /max reply）',
    run: async ({ args, services }) => {
      const { config, configStore, reply } = services
      const [sub, val] = args
      if (sub === 'on' || sub === 'off') {
        configStore.set({ reply: { segment: sub === 'on' } })
        return reply(`分段发送：${sub === 'on' ? '开启' : '关闭'}`)
      }
      if (sub === 'delay') {
        const n = Number(val)
        if (!n || n < 0) return reply('用法：/reply delay <毫秒>（安全值 800-2000）')
        configStore.set({ reply: { segmentDelayMs: n } })
        return reply('分段间隔：' + n + 'ms')
      }
      if (sub === 'tokens' || sub === 'maxtokens') {
        const n = Number(val)
        if (!n || n < 1) {
          const lim = services.providers ? outputTokenLimit(services.providers.activeId) : null
          return reply(
            '用法：/reply tokens <最大回复 tokens>' + (lim ? `（本服务商上限 ${lim}）` : '') + '\n看/改全部生成上限用 /max'
          )
        }
        configStore.set({ llm: { maxTokens: n } })
        return reply('模型回复上限：' + n + ' tokens（细分项见 /max）')
      }
      if (sub === 'merge') {
        const n = Number(val)
        if (Number.isNaN(n) || n < 0) return reply('用法：/reply merge <毫秒>（0 = 关闭；建议 1500-4000）')
        configStore.set({ reply: { mergeWindowMs: n } })
        return reply(n === 0
          ? '图文合并：已关闭（图片一到就处理）'
          : '图文合并：图片到达后等 ' + n + 'ms，若期间又收到文字就并成一轮再回复')
      }
      const r = config.reply || {}
      const llm = config.llm || {}
      return reply(
        '分段发送：' + (r.segment !== false ? '开启' : '关闭') + '\n' +
          '单条回复条数上限：' + (r.maxSegmentsPerReply ?? 10) + ' 条（超出会合并）\n' +
          '间隔：' + (r.segmentDelayMs ?? 1200) + 'ms（抖动 ' + (r.segmentJitterMs ?? 500) + 'ms）\n' +
          '单条长度上限：' + (r.maxCharsPerMessage ?? 1800) + ' 字\n' +
          '图文合并窗口：' + ((r.mergeWindowMs ?? 2500) > 0 ? (r.mergeWindowMs ?? 2500) + 'ms（图片后补的话会并成一轮）' : '关闭') + '\n' +
          '模型回复上限：' + (llm.maxTokens ?? 1024) + ' tokens\n\n' +
          '设置：/reply on|off　/reply delay <ms>　/reply tokens <n>　/reply merge <ms>'
      )
    }
  })

  router.register({
    name: 'resendimg',
    description: '把最近收到的图片原样回发（验证图片出站通道）',
    run: async ({ inbound, services }) => {
      const file = services.store.get('lastInboundImage')
      if (!file) return services.reply('还没有收到过图片，请先发一张。')
      try {
        const buf = fs.readFileSync(file)
        await services.channel.sendImage(inbound.userId, buf, inbound.contextToken)
        await services.reply('已原样回发最近一张图片（' + buf.length + 'B）。这张能打开吗？')
      } catch (e) {
        services.logger.error('resendimg 失败：', e.message)
        await services.reply('回发失败：' + e.message)
      }
    }
  })

  router.register({
    name: 'diagvideo',
    description: '回发最近收到的视频：/diagvideo [video_size|len|mid_size|file]',
    run: async ({ args, inbound, services }) => {
      const file = services.store.get('lastInboundVideo')
      if (!file) return services.reply('还没收到过视频，请先发一段（视频会下载留档）。')
      try {
        const buf = fs.readFileSync(file)
        const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
        const mode = (args[0] || '').toLowerCase()

        // 文件通道不压缩：需要逐字节一致时走这条
        if (mode === 'file') {
          await services.channel.sendFile(inbound.userId, buf, 'diag-video.mp4', inbound.contextToken)
          return services.reply(
            `已按【文件】回发（${buf.length}B，sha256:${sha}）。\n` +
              '文件通道不压缩，收到的应当就是这个大小；\n' +
              '若这里对得上、而视频通道对不上，就说明压缩发生在视频通道。'
          )
        }

        const info = await services.channel.sendVideo(inbound.userId, buf, inbound.contextToken, {
          sizeField: mode || undefined,
          fileName: 'diag-video.mp4'
        })
        await services.reply(
          `已按【视频】回发（${info.rawSize}B，sha256:${sha}，密文大小字段 ${info.sizeField}）。\n` +
            '若收到的体积明显小于这个数字，就是走视频通道时被微信转码压缩了。\n' +
            '要逐字节一致请改用：/diagvideo file（文件通道不压缩）\n' +
            '字段名不对时换着试：/diagvideo len 、/diagvideo mid_size'
        )
      } catch (e) {
        services.logger.error('diagvideo 失败：', e.message)
        await services.reply('视频回发失败：' + e.message)
      }
    }
  })

  router.register({
    name: 'diag',
    description: '媒体发送诊断：发一张测试图片 + 一个测试 JSON 文件',
    run: async ({ inbound, services }) => {
      const channel = services.channel
      if (!channel || !channel.running) return services.reply('通道未就绪，无法发送。')
      const { SAMPLE_PNG_BASE64 } = await import('../util/sample.js')
      try {
        const payload = (tag) => Buffer.from(JSON.stringify({ tag, note: '看到本文件说明文件发送可用' }, null, 2))
        await services.reply('① 测试图片')
        await channel.sendImage(inbound.userId, Buffer.from(SAMPLE_PNG_BASE64, 'base64'), inbound.contextToken)
        await services.reply('② diag-a.txt（len 字符串）')
        await channel.sendFile(inbound.userId, payload('a'), 'diag-a.txt', inbound.contextToken)
        await services.reply('③ diag-b.json（len 字符串）')
        await channel.sendFile(inbound.userId, payload('b'), 'diag-b.json', inbound.contextToken)
        await services.reply('④ 已完成：图片 + diag-a.txt + diag-b.json。请告诉我收到哪几个。')
      } catch (e) {
        services.logger.error('diag 发送失败：', e.message)
        await services.reply('发送失败：' + e.message)
      }
    }
  })

  router.register({
    name: 'whoami',
    description: '查看你的用户 ID',
    run: async ({ inbound, services }) => services.reply(`userId: ${inbound.userId}`)
  })
}
