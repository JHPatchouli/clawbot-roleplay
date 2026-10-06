/**
 * 总结命令：生成 / 查看 / 导出。
 */
export function registerSummaryCommands(router) {
  router.register({
    name: 'summary',
    aliases: ['sum'],
    description: '总结：now（生成）/ list / del <序号> / clear',
    run: async ({ args, inbound, services }) => {
      const summary = services.summary
      const reply = services.reply
      const sub = (args[0] || '').toLowerCase()

      if (sub === 'now' || sub === 'gen') {
        const session = services.chatSessions.current(inbound.userId)
        const msgs = services.history.list(inbound.userId, session.id)
        if (!msgs.length) return reply('当前会话还没有内容。')
        await reply('正在生成总结…')
        try {
          const s = await summary.generate({ userId: inbound.userId, sessionId: session.id, messages: msgs })
          return reply('总结（' + s.content.length + ' 字）：\n\n' + s.content)
        } catch (e) {
          return reply('生成失败：' + e.message)
        }
      }
      if (sub === 'del') {
        const list = summary.list(inbound.userId)
        const i = Number(args[1])
        const s = Number.isInteger(i) && i >= 1 ? list[i - 1] : null
        if (!s) return reply('序号无效，先发 /summary')
        summary.remove(s.id)
        return reply('已删除总结。')
      }
      if (sub === 'clear') {
        const n = summary.clear(inbound.userId)
        return reply('已清空你自己的 ' + n + ' 条总结。')
      }

      const list = summary.list(inbound.userId)
      if (!list.length) return reply('暂无总结。用 /summary now 生成当前会话总结。')
      const lines = ['总结（' + list.length + ' 条，最新在前）：']
      list.slice(0, 10).forEach((s, i) => {
        lines.push((i + 1) + '. [' + new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false }) + '] ' + s.content.slice(0, 50) + '…')
      })
      lines.push('', '生成：/summary now　删除：/summary del <序号>')
      await reply(lines.join('\n'))
    }
  })
}
