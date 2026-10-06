/**
 * 主动消息命令：状态 / 开关 / 调参 / 立刻试一次。
 *
 * 为什么要有 `now`：这功能是「等随机时间」的，没有它用户只能干等半小时才知道好不好用。
 * `now` 走的**是同一条发起链路**（`proactive.fireNow` → `router.initiateTurn`），
 * 所以它证明得了「真到点时会说话」，也能顺手当回滚验证（关掉后再试会明确拒绝）。
 */
export function registerProactiveCommands(router) {
  router.register({
    name: 'proactive',
    aliases: ['auto', '主动'],
    description: '主动找你：状态 / on|off / gap <min>-<max> / silence <min> / cap <n> / quiet <a>-<b> / now',
    run: async ({ inbound, args, services }) => {
      const { proactive, configStore, reply } = services
      if (!proactive) return reply('主动开口模块未接线（没有通道时不会启动）。')
      const [sub, a, ...rest] = args || []

      if (sub === 'on' || sub === 'off') {
        const on = sub === 'on'
        // off 同时上锁：她在聊天里也改不动（`proactive` 工具会拒绝 resume）——
        // 否则「回滚闸门」就成了摆设（她一句话就能把它翻回来）
        configStore.set({ proactive: { enabled: on, lockedByUser: !on } })
        if (on) proactive.start()
        else proactive.stop()
        return reply(
          '主动找你：' + (on ? '已开启' : '**已关闭**（定时器已停，不会再主动发任何消息；她也改不回来，要开得你说 /proactive on）') +
            (on ? '\n她会按随机间隔主动开口；不想被打扰随时 `/proactive off`。' : '')
        )
      }

      if (sub === 'gap') {
        const m = /^(\d+)\s*[-~到]\s*(\d+)$/.exec((a || '') + '')
        if (!m) return reply('用法：/proactive gap <最短分钟>~<最长分钟>（例如 /proactive gap 30-120）')
        const lo = Number(m[1])
        const hi = Number(m[2])
        if (!(lo >= 1 && hi >= lo && hi <= 24 * 60)) return reply('间隔得是「1~1440 分钟、且上限不小于下限」。')
        configStore.set({ proactive: { minGapMinutes: lo, maxGapMinutes: hi } })
        return reply('随机间隔：' + lo + '~' + hi + ' 分钟（每次触发后重新随机）')
      }

      if (sub === 'silence') {
        const n = Number(a)
        if (!Number.isFinite(n) || n < 0 || n > 24 * 60) return reply('用法：/proactive silence <0~1440 分钟>')
        configStore.set({ proactive: { minSilenceMinutes: Math.round(n) } })
        return reply('至少静默 ' + Math.round(n) + ' 分钟后才会主动开口（刚聊完不会来打扰）。')
      }

      if (sub === 'cap') {
        const n = Number(a)
        if (!Number.isFinite(n) || n < 0 || n > 50) return reply('用法：/proactive cap <0~50>（0 = 不限）')
        configStore.set({ proactive: { maxPerDay: Math.round(n) } })
        return reply('每天最多主动 ' + (Math.round(n) || '不限') + ' 次。')
      }

      if (sub === 'quiet') {
        const m = /^(\d{1,2})\s*[-~到]\s*(\d{1,2})$/.exec((a || '') + '')
        if (!m) return reply('用法：/proactive quiet <起>~<止>（小时，例如 /proactive quiet 23-9）')
        const from = Number(m[1])
        const to = Number(m[2])
        if (from > 23 || to > 24) return reply('小时得在 0~24 之间（23-9 表示 23 点到次日 9 点不打扰）。')
        configStore.set({ proactive: { quietFromHour: from, quietToHour: to } })
        return reply('静默时段：' + from + ' 点到 ' + to + ' 点不主动开口。')
      }

      if (sub === 'now') {
        const r = await proactive.fireNow(inbound.userId)
        return reply(r && r.ok ? '好——她已经主动说了一句（走的就是定时那条链路）。' : '这次没发出去：' + ((r && r.reason) || '未知'))
      }

      if (sub && sub !== 'status') return reply('用法：/proactive [on|off|gap|silence|cap|quiet|now]')

      // ---- 状态 ----
      const s = proactive.status()
      const lines = ['**主动找你**：' + (s.enabled ? '开启' : '关闭') + (s.running ? '（调度在跑）' : '（调度已停）')]
      lines.push('· 随机间隔：' + s.minGapMinutes + '~' + s.maxGapMinutes + ' 分钟（下次约 ' + s.nextDelayMinutes + ' 分钟后检查）')
      lines.push('· 至少静默：' + s.minSilenceMinutes + ' 分钟')
      lines.push('· 每天上限：' + (s.maxPerDay || '不限') + ' 次')
      lines.push('· 静默时段：' + s.quietFromHour + ' 点 ~ ' + s.quietToHour + ' 点' + (s.quietNow ? '（**现在是静默时段**）' : ''))
      for (const u of s.users.slice(0, 5)) {
        lines.push(
          '· 对象 ' + String(u.userId).slice(0, 10) + '…｜今天已发 ' + u.firedToday + ' 次｜静默 ' +
            (u.silentMinutes == null ? '无记录' : u.silentMinutes + ' 分钟') +
            (u.blockReason ? '｜当前不能发：' + u.blockReason : '｜**当前可以发**')
        )
      }
      lines.push('', '试一次：/proactive now　｜　关掉：/proactive off（立刻停止，不用改代码）')
      return reply(lines.join('\n'))
    }
  })
}
