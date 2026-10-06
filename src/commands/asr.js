/**
 * 语音命令：看状态、开关、换识别模型、复查最近一条语音。
 *
 * 为什么要有 `/asr test`：语音识别是**只能靠真实语音验证**的能力，
 * 而让人为了排查再录一条很麻烦 —— 把最近那条语音（只留在内存里）重跑一遍，
 * 就能当场区分「解码坏了」「网络坏了」「模型听不清」这三种完全不同的原因。
 */
const K = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB')

export function registerAsrCommands(router) {
  router.register({
    name: 'asr',
    aliases: ['stt', 'voice'],
    description: '语音识别：状态 / on|off / model <模型名> / last / test',
    run: async ({ args, services }) => {
      const { asr, configStore, reply } = services
      if (!asr) return reply('语音识别模块未启用。')
      const [sub, a, b] = args || []

      if (sub === 'on' || sub === 'off') {
        configStore.set({ asr: { enabled: sub === 'on' } })
        const s = asr.status()
        const tail = sub === 'on' && !s.usable ? '\n⚠️ 现在还不可用：' + s.usableReason : ''
        return reply('语音识别：' + (sub === 'on' ? '开启' : '关闭') + '（下一轮生效）' + tail)
      }

      if (sub === 'diar' || sub === 'speakers') {
        const val = String(a || '').toLowerCase()
        if (val === 'notify') {
          const nv = String(b || '').toLowerCase()
          if (nv !== 'on' && nv !== 'off') return reply('用法：/asr diar notify on|off（是否把「有多人在说」写进对话）')
          configStore.set({ asr: { diarize: { notify: nv === 'on' } } })
          return reply(
            nv === 'on'
              ? '已开启：多人语音会在她的上下文里多一句提醒。⚠️ 这个人数会误报（单人短句被判成 3 人），确认可靠再用。'
              : '已关闭：人数只显示在 /asr last 与验证回执里，不写进对话。'
          )
        }
        if (val !== 'on' && val !== 'off') return reply('用法：/asr diar on|off　/asr diar notify on|off')
        configStore.set({ asr: { diarize: { enabled: val === 'on' } } })
        return reply(
          '说话人判定：' +
            (val === 'on' ? '开启（每条语音多跑一次分离模型，约 +0.8s）' : '关闭（省一次调用与 ~0.8s 延迟）') +
            '（下一轮生效）'
        )
      }

      if (sub === 'mode') {
        const m = String(a || '').toLowerCase()
        if (m !== 'probe' && m !== 'chat') {
          return reply(
            '用法：/asr mode probe|chat\n· probe = 只回传识别结果，不进对话（当前默认，用于验证）\n· chat = 把转写当成「他说的话」进正常一轮'
          )
        }
        configStore.set({ asr: { mode: m } })
        return reply(
          m === 'probe'
            ? '语音识别：验证模式（probe）——只把识别结果回传给你看，不写历史、不调模型、不进记忆。'
            : '语音识别：对话模式（chat）——转写会当成「他说的话」进正常一轮（会写进会话历史）。'
        )
      }

      if (sub === 'model') {
        const m = String(a || '').trim()
        if (!m) return reply('用法：/asr model <模型名>\n当前：' + asr.status().model)
        configStore.set({ asr: { model: m } })
        const s = asr.status()
        const warn = s.providerOk ? '' : '\n⚠️ 服务商不可用：' + s.providerReason
        return reply('语音识别模型已换成：' + m + '\n（改完立即生效，下次收到语音就用它）' + warn)
      }

      if (sub === 'last') {
        const l = asr.status().last
        if (!l) return reply('还没有收到过语音。')
        const lines = [
          '最近一条语音（' + new Date(l.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '）：',
          '· 结果：' + (l.ok ? '识别成功' : '失败 — ' + l.reason),
          '· 格式：' + l.format + (l.sampleRate ? '　采样率 ' + l.sampleRate + 'Hz' : ''),
          '· 大小：' + K(l.bytes) + '　耗时 ' + l.ms + 'ms　尝试 ' + l.attempts + ' 次'
        ]
        if (l.speakers) lines.push('· 说话人：' + l.speakers + ' 个' + (l.speakers > 1 ? '（不止一个人在说）' : ''))
        // 协议字段名是我们唯一的外部依赖（文档没公开），出问题时这一行就是线索
        if (l.itemFields && l.itemFields.length) lines.push('· 协议 voice_item 字段：' + l.itemFields.join(','))
        if (l.ok && l.text) lines.push('', '识别文本：' + l.text)
        return reply(lines.join('\n'))
      }

      if (sub === 'test') {
        const r = await asr.retest()
        if (!r.ok && /还没有收到过语音/.test(r.reason || '')) return reply(r.reason)
        const lines = [
          '重跑最近那条语音：' + (r.ok ? '成功' : '失败 — ' + r.reason),
          '· 格式：' + r.format + (r.sampleRate ? '　采样率 ' + r.sampleRate + 'Hz' : ''),
          '· 耗时 ' + r.ms + 'ms　尝试 ' + r.attempts + ' 次　模型 ' + (r.model || '(未配)')
        ]
        if (r.ok) lines.push('', '识别文本：' + r.text)
        return reply(lines.join('\n'))
      }

      // ---- 无参数：状态 ----
      const s = asr.status()
      const cd = asr.probeCodec ? await asr.probeCodec() : { ok: true, reason: null }
      const lines = [
        '语音识别：' + (s.enabled ? '开启' : '关闭') + (s.enabled && s.usable ? '（生效中）' : s.enabled ? '（不可用：' + s.usableReason + '）' : '（随开关关闭）'),
        '· 模式：' + (s.mode === 'chat' ? 'chat（转写进对话）' : 'probe（只回传结果，不进对话）'),
        '· 模型：' + s.model,
        '· 服务商：' + s.provider + (s.providerOk ? '（有密钥）' : '（不可用：' + s.providerReason + '）'),
        '· SILK 解码器：' + (cd.ok ? '已装（silk-wasm）' : '没装 — ' + cd.reason),
        '· 说话人判定：' + (s.diarize ? '开启（' + s.diarizeModel + '，只数人数）' : '关闭') + '　多人提醒：' + (s.diarizeNotify ? '开（会写进对话）' : '关（仅诊断）') + '　/asr diar on|off',
        '· SILK 采样率假设：' + s.sampleRate + 'Hz' + (s.silkRateLabel ? '（' + s.silkRateLabel + '）' : '') + '，空结果时自动换 16k/8k 再试',
        '· 单条上限：' + K(s.maxBytes) + '　超时 ' + Math.round(s.timeoutMs / 1000) + 's',
        '· 音频不落盘：只留在内存里供 /asr test 复跑'
      ]
      if (s.last) {
        lines.push(
          '· 最近一条：' + (s.last.ok ? '成功' : '失败 — ' + s.last.reason) + '（' + s.last.format + '，' + s.last.ms + 'ms）'
        )
      } else {
        lines.push('· 最近一条：还没收到过语音')
      }
      lines.push('', '/asr on|off　/asr mode probe|chat　/asr model <模型名>　/asr last　/asr test')
      return reply(lines.join('\n'))
    }
  })
}
