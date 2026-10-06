/**
 * 委托命令：看状态、开关、手动委托一次、查最近一次干了什么。
 *
 * 为什么要有 `/agent run`：委托是「模型自己决定」的能力，出问题时很难复现——
 * 用户想让它干活，但模型可能就是不调工具。给一条手动通道，
 * 既能当场验证链路，也能用来分辨「链路坏了」还是「模型没想起来用」。
 */
export function registerAgentCommands(router) {
  router.register({
    name: 'agent',
    aliases: ['delegate', 'worker'],
    description: '委托：状态 / log / on|off / key <密钥> / run <任务> / max <往返数> / timeout <秒>',
    run: async ({ inbound, args, services }) => {
      const { delegator, configStore, reply } = services
      if (!delegator) return reply('委托器未启用。')
      const [sub, ...rest] = args || []
      const info = delegator.info()

      // ---- 开关 ----
      if (sub === 'on' || sub === 'off') {
        configStore.set({ agent: { enabled: sub === 'on' } })
        const av = delegator.available()
        return reply(
          '委托：' + (sub === 'on' ? '开启' : '关闭') +
            (sub === 'on' && !av.ok ? '\n⚠️ 但当前不可用：' + av.reason : '')
        )
      }

      // ---- 专用 Key（聊天里直接换，不用碰服务器） ----
      if (sub === 'key') {
        const v = rest.join(' ').trim()
        if (!v) {
          return reply(
            '委托专用 Key：' + info.keySource + '\n' +
              '用法：/agent key <密钥>（设新的）　/agent key clear（清除，回落到对话 Provider 的 Key）\n' +
              '⚠️ 这条消息在日志里会整条作废（按密钥处理），但对方对话框里仍然看得见，别在公开场合发。'
          )
        }
        if (/^(clear|del|none)$/i.test(v)) {
          configStore.set({ agent: { apiKey: '' } })
          return reply('已清除专用 Key，下一步委托会回落到对话 Provider 的 Key（/' + 'agent key <密钥> 可再设）。')
        }
        if (v.length < 20 || /\s/.test(v)) return reply('这不像密钥（长度 ' + v.length + '，且不应含空格）。检查一下再发。')
        configStore.set({ agent: { apiKey: v } })
        const av = delegator.available()
        return reply(
          '委托专用 Key 已更新：' + v.slice(0, 7) + '…' + v.slice(-4) + '\n' +
            '立即生效（下一轮委托就用它，不用重启）' + (av.ok ? '' : '\n⚠️ 但当前仍不可用：' + av.reason)
        )
      }

      // ---- 成本/时长上限 ----
      if (sub === 'max') {
        const n = Number(rest[0])
        if (!Number.isFinite(n) || n < 1 || n > 30) return reply('用法：/agent max <1~30 的往返数>')
        configStore.set({ agent: { maxTurns: Math.round(n) } })
        return reply('委托最多 ' + Math.round(n) + ' 个往返（到点就收尾）。')
      }
      if (sub === 'timeout') {
        const s = Number(rest[0])
        if (!Number.isFinite(s) || s < 10 || s > 900) return reply('用法：/agent timeout <10~900 秒>')
        configStore.set({ agent: { timeoutMs: Math.round(s) * 1000 } })
        return reply('委托硬超时：' + Math.round(s) + ' 秒（到点强制结束）。')
      }

      // ---- 最近一次 ----
      if (sub === 'log') {
        const l = delegator.last()
        if (!l) return reply('还没有委托过（让她干点活，或 /agent run <任务> 手动试一次）。')
        const mins = Math.round((Date.now() - l.at) / 60000)
        const lines = [
          '最近一次委托（' + mins + ' 分钟前）',
          '· 任务：' + l.task.slice(0, 200),
          '· 结果：' + (l.ok ? '完成' : '未完成' + (l.error ? '（' + l.error + '）' : '')),
          '· 耗时：' + Math.round((l.ms || 0) / 1000) + 's　往返：' + (l.turns ?? '?') + '　工具调用：' + (l.toolCalls || []).length + ' 次'
        ]
        if (l.usage) {
          const u = l.usage
          lines.push('· tokens：输入 ' + (u.input_tokens ?? '?') + ' 输出 ' + (u.output_tokens ?? '?') + '（缓存读 ' + (u.cache_read_input_tokens ?? 0) + '）')
        }
        if (l.toolCalls && l.toolCalls.length) {
          lines.push('· 它做了什么：')
          for (const t of l.toolCalls.slice(0, 8)) lines.push('　- ' + t.name + ' ' + String(t.input).slice(0, 100))
        }
        if (l.files && l.files.length) {
          lines.push('· 产物：' + l.files.map((f) => f.path + '(' + f.bytes + 'B)').join('、').slice(0, 300))
        }
        lines.push('', '· 结论：' + (l.text || '(空)').slice(0, 600))
        return reply(lines.join('\n'))
      }

      // ---- 手动委托 ----
      if (sub === 'run') {
        const task = rest.join(' ').trim()
        if (!task) return reply('用法：/agent run <要它做的事>\n例：/agent run 写个脚本调用 https://api.github.com/repos/nodejs/node，把 star 数算成万并保留一位小数')
        const av = delegator.available()
        if (!av.ok) return reply('委托不可用：' + av.reason)
        // ⚠️ 这条是**当场等结果**的（她那条路是后台跑，见 delegate_task）：
        //    留着它是为了验证链路 / 「我就想站在这儿看它干完」
        await reply(
          '已把任务交出去，这条我会当场等到它干完（最多 ' +
            Math.round(delegator.budgetMs?.() / 1000 || info.timeoutMs / 1000) +
            ' 秒）。想让它挂后台跑就说给它听（她调 delegate_task 时不阻塞）。'
        )
        // 和模型走的那条路一样：手动委托也要申请延长本轮时限，
        // 否则通道的底数（默认 150s）会先把这一轮判死，用户只看到一句报错
        try {
          services.extendTimeout?.(delegator.budgetMs?.() || 0)
        } catch (_) {
          /* 延长失败不影响委托本身 */
        }
        const r = await delegator.run(task, { userId: inbound.userId, sessionId: null, characterId: null })
        const meta = r.meta || {}
        return reply(
          (r.ok ? '✅ 委托完成' : '⚠️ 委托未完成') +
            '（' + Math.round((meta.ms || 0) / 1000) + 's，往返 ' + (meta.turns ?? '?') + '）\n\n' +
            (r.text || '(没有结论)')
        )
      }

      // ---- 无参数：状态 ----
      const lines = ['委托（把活外包给成熟的 agent 框架）']
      lines.push('· 状态：' + (info.ok ? '可用' : '不可用 —— ' + info.reason))
      lines.push('· 框架目录：' + info.installDir + (info.ok ? '' : '（未安装）'))
      lines.push('· 模型：' + info.model + '　端点：' + info.baseUrl)
      lines.push('· Key：' + info.keySource)
      lines.push('· 上限：最多 ' + info.maxTurns + ' 个往返 / 硬超时 ' + Math.round(info.timeoutMs / 1000) + 's')
      lines.push(
        '· 运行身份：' + (info.dropping ? '降权为 nobody（读不到 data/）' : '⚠️ 与主进程同权限（非 root 启动时无法降权）')
      )
      lines.push('· 工作目录：' + info.workDir + '（按用户分目录，持久保留）')
      if (info.busy) lines.push('· 当前有一次委托正在跑')
      if (info.queue) lines.push('· 还排着 ' + info.queue + ' 件（最多 ' + info.maxQueue + ' 件，做完一件接一件）')
      if (info.last) lines.push('· 最近一次：' + Math.round((Date.now() - info.last.at) / 60000) + ' 分钟前，' + (info.last.ok ? '完成' : '未完成'))
      lines.push(
        '',
        '怎么用：她自己会在需要动手时调 delegate_task（你只要正常说话）。',
        '手动试：/agent run <任务>　最近一次详情：/agent log　开关：/agent on|off　换 Key：/agent key <密钥>'
      )
      return reply(lines.join('\n'))
    }
  })
}
