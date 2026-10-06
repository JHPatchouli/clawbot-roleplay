/**
 * 会话命令：多上下文分离，避免不同话题互相污染。
 */
export function registerSessionCommands(router) {
  router.register({
    name: 'session',
    aliases: ['sess', 's'],
    description: '会话：list / new [名称] / use <序号> / rename <名称> / del <序号>',
    run: async ({ args, inbound, services }) => {
      const chatSessions = services.chatSessions
      const history = services.history
      const reply = services.reply
      const uid = inbound.userId
      const sub = (args[0] || 'list').toLowerCase()
      const cur = chatSessions.current(uid) // 先确保至少有一个会话
      const list = chatSessions.list(uid)

      if (sub === 'new') {
        const s = chatSessions.create(uid, args.slice(1).join(' '))
        return reply('已新建会话「' + s.name + '」并切换过去（上下文为空）。')
      }
      if (sub === 'use') {
        const s = pick(list, args[1])
        if (!s) return reply('序号无效，先发 /session list')
        chatSessions.use(uid, s.id)
        return reply('已切换到「' + s.name + '」（' + history.size(uid, s.id) + ' 条消息）。')
      }
      if (sub === 'rename') {
        const name = args.slice(1).join(' ')
        if (!name) return reply('用法：/session rename <名称>')
        const s = chatSessions.rename(uid, cur.id, name)
        return reply('已重命名为「' + s.name + '」。')
      }
      if (sub === 'del') {
        const s = pick(list, args[1])
        if (!s) return reply('序号无效，先发 /session list')
        if (list.length <= 1) return reply('至少保留一个会话，无法删除。')
        // 先把「这个会话名下有什么」算清楚再问，别让用户凭空确认。
        // 独占记忆 = sessionId 正好是这个会话的那些（全局记忆是 sessionId 为空，不在其中）。
        const msgs = history.size(uid, s.id)
        const exclusive = services.memory ? services.memory.list(uid, { sessionId: s.id }).filter((m) => m.sessionId === s.id) : []
        const sums = services.summary ? services.summary.list(uid).filter((x) => x.sessionId === s.id) : []
        const confirm = String(args[2] || '').toLowerCase() === 'confirm'
        if (!confirm && (msgs || exclusive.length || sums.length)) {
          return reply(
            [
              '将删除会话「' + s.name + '」，并**连带删除**属于它的：',
              '· 消息 ' + msgs + ' 条',
              '· 独占记忆 ' + exclusive.length + ' 条（连向量一起删）',
              '· 剧情总结 ' + sums.length + ' 条',
              '全局记忆与别的会话不受影响。',
              '',
              '确认请回复：/session del ' + args[1] + ' confirm'
            ].join('\n')
          )
        }
        // 删会话必须「删干净」：以前只删记录，它的历史/记忆/向量全留在库里，
        // 而那些记忆按会话隔离后又**在哪儿都看不到**，只能靠外部脚本清
        chatSessions.remove(uid, s.id)
        history.clear(uid, s.id)
        const r = services.memory ? services.memory.removeSession(s.id, { userId: uid }) : { memories: 0, vectors: 0 }
        for (const x of sums) services.summary.remove(x.id)
        return reply(
          '已删除会话「' + s.name + '」：消息 ' + msgs + ' 条、独占记忆 ' + r.memories + ' 条（向量 ' + r.vectors +
            '）、总结 ' + sums.length + ' 条。\n全局记忆与别的会话未动。'
        )
      }
      const lines = ['会话（上下文相互独立）：']
      list.forEach((s, i) => {
        lines.push((i + 1) + '. ' + s.name + (s.id === cur.id ? ' ← 当前' : '') + '（' + history.size(uid, s.id) + ' 条）')
      })
      lines.push('', '新建：/session new [名称]　切换：/session use <序号>')
      lines.push('重命名：/session rename <名称>　删除：/session del <序号>')
      await reply(lines.join('\n'))
    }
  })
}

function pick(list, idxArg) {
  const i = Number(idxArg)
  if (!Number.isInteger(i) || i < 1 || i > list.length) return null
  return list[i - 1]
}
