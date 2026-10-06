/**
 * 感知命令：查看感知状态、开关各能力、配时区、预览「这一轮到底注入了什么」。
 *
 * 「预览」是刻意做的：感知内容是注入进提示词的，用户平时看不见；
 * 一旦角色说了奇怪的时间，得能当场把注入原文调出来 —— 否则只能靠猜。
 */
import { isValidTimeZone, DEFAULT_TIME_ZONE, nowText, gapInfo, lastSpokeAt } from '../perception/senses/time.js'
import { parseLatLon, geocodePlace, providerIds, cleanPlaceLabel, PLACE_MAX } from '../perception/senses/weather.js'

export function registerPerceptionCommands(router) {
  router.register({
    name: 'perc',
    aliases: ['perception', 'sense'],
    description: '感知：状态 / preview / now / on|off / time / tz / gap / weather / city',
    run: async ({ inbound, args, services }) => {
      const { perception, configStore, history, chatSessions, reply } = services
      if (!perception) return reply('感知模块未启用。')
      const [sub, a, ...rest] = args || []

      if (sub === 'on' || sub === 'off') {
        configStore.set({ perception: { enabled: sub === 'on' } })
        // ⚠️ 规范文字（system 里那条）是随开关变的：变更后**下一轮**的 system 段会变，
        // 那一次的前缀缓存必然重算。这是开关语义本身决定的，不是 bug。
        return reply('感知：' + (sub === 'on' ? '开启' : '关闭') + '（下一轮生效，本轮 system 段会因此重算一次）')
      }

      if (sub === 'time') {
        const val = (a || '').toLowerCase()
        if (val !== 'on' && val !== 'off') return reply('用法：/perc time on|off')
        configStore.set({ perception: { time: { enabled: val === 'on' } } })
        return reply('时间感知：' + (val === 'on' ? '开启' : '关闭') + '（下一轮生效）')
      }

      if (sub === 'tz') {
        const tz = (a || '').trim()
        if (!isValidTimeZone(tz)) {
          return reply('时区无效：' + (tz || '(空)') + '\n请用 IANA 名称，如 Asia/Shanghai / UTC / America/New_York')
        }
        configStore.set({ perception: { time: { timeZone: tz } } })
        return reply('时区已设为 ' + tz + '，现在是 ' + nowText(Date.now(), tz))
      }

      if (sub === 'gap') {
        const h = Number(a)
        if (!Number.isFinite(h) || h < 1 || h > 72) return reply('用法：/perc gap <1~72 的小时数>')
        configStore.set({ perception: { time: { gapNoticeHours: Math.round(h) } } })
        return reply('间隔提示阈值：超过 ' + Math.round(h) + ' 小时才提醒「别接着演上文」。')
      }

      // ── 天气感知 ──
      if (sub === 'weather') {
        const val = (a || '').toLowerCase()
        if (val === 'on' || val === 'off') {
          configStore.set({ perception: { weather: { enabled: val === 'on' } } })
          return reply('天气感知：' + (val === 'on' ? '开启' : '关闭') + '（下一轮生效）')
        }
        if (val === 'provider') {
          const name = (args[2] || '').trim()
          if (!name) return reply('可用 provider：' + providerIds().join(' / '))
          if (!providerIds().includes(name)) return reply('未知 provider：' + name + '\n可用：' + providerIds().join(' / '))
          configStore.set({ perception: { weather: { provider: name } } })
          return reply('天气 provider 已设为 ' + name + '（下一轮生效）')
        }
        if (val === 'ttl') {
          const m = Number(args[2])
          if (!Number.isFinite(m) || m < 1 || m > 720) return reply('用法：/perc weather ttl <1~720 分钟>')
          configStore.set({ perception: { weather: { ttlMinutes: Math.round(m) } } })
          return reply('天气缓存时长：' + Math.round(m) + ' 分钟。')
        }
        if (val === 'key') {
          const k = (args[2] || '').trim()
          if (!k) return reply('用法：/perc weather key <密钥>（用 clear 清除）')
          if (k === 'clear') {
            configStore.set({ perception: { weather: { apiKey: '' } } })
            return reply('已清除天气 API key。')
          }
          configStore.set({ perception: { weather: { apiKey: k } } })
          const masked = k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : '（已设置）'
          return reply('天气 API key 已设置（' + masked + '）。\n它只落盘在容器内，不会进仓库。')
        }
        const w = perception.capabilities().weather || {}
        const places = w.places || []
        const where = places.length
          ? places.map((p, i) => (i + 1) + '. ' + (p.label || '（无备注）') + '　' + p.latitude + ',' + p.longitude).join('\n')
          : '未设置'
        return reply(
          '天气感知：' + (w.enabled === false ? '已关闭' : '开启') + '\n' +
          '· provider：' + (w.provider || '(未设)') + '\n' +
          '· 地点（' + places.length + '）：\n' + where + '\n' +
          '用法：/perc weather on|off | provider <名> | ttl <分钟> | key <密钥>\n' +
          '地点：/perc city <备注> <纬度>,<经度>　｜　/perc city del <序号>'
        )
      }

      // ── 地理位置（可多处，每处一个备注）──
      if (sub === 'city') {
        const w = perception.capabilities().weather || {}
        const cur = configStore.get().perception?.weather || {}
        // 名单优先；名单还是空的时候，把升级前设过的单点收进来，避免一加第二处就把第一处弄丢
        let places = Array.isArray(cur.places) && cur.places.length
          ? cur.places.map((p) => ({ label: cleanPlaceLabel(p && p.label), latitude: p && p.latitude, longitude: p && p.longitude }))
          : (Number.isFinite(w.latitude)
              ? [{ label: cleanPlaceLabel(w.label), latitude: w.latitude, longitude: w.longitude }]
              : [])
        const show = () => places.length
          ? places.map((p, i) => (i + 1) + '. ' + (p.label || '（无备注）') + '　' + p.latitude + ',' + p.longitude).join('\n')
          : '（还没有）'
        const rest = args.slice(1)
        const head = (rest[0] || '').toLowerCase()

        if (!rest.length) {
          return reply('天气地点：\n' + show() + '\n' +
            '加一处：/perc city <备注> <纬度>,<经度>　　例 /perc city 家 31.23,121.47\n' +
            '删一处：/perc city del <序号>　　改备注：/perc city rename <序号> <新备注>\n' +
            '清空：/perc city clear\n' +
            '⚠️ 中文地名解析很不可靠，**不自动采用**。建议手机地图长按地点，直接贴坐标。')
        }

        if (head === 'clear') {
          configStore.set({ perception: { weather: { places: [], latitude: null, longitude: null, label: '' } } })
          return reply('已清空全部天气地点。')
        }
        if (head === 'del' || head === 'rm') {
          const n = Number(rest[1])
          if (!Number.isInteger(n) || n < 1 || n > places.length) {
            return reply('用法：/perc city del <序号>\n当前：\n' + show())
          }
          const gone = places.splice(n - 1, 1)[0]
          configStore.set({ perception: { weather: { places, latitude: null, longitude: null, label: '' } } })
          return reply('已删除「' + (gone.label || '无备注') + '」。\n还剩：\n' + show())
        }
        if (head === 'rename') {
          const n = Number(rest[1])
          const label = cleanPlaceLabel(rest.slice(2).join(' '))
          if (!Number.isInteger(n) || n < 1 || n > places.length || !label) {
            return reply('用法：/perc city rename <序号> <新备注>\n当前：\n' + show())
          }
          places[n - 1] = { ...places[n - 1], label }
          configStore.set({ perception: { weather: { places, latitude: null, longitude: null, label: '' } } })
          return reply('已改备注。\n' + show())
        }

        // 「备注 坐标」或光一个坐标（兼容旧的 /perc city 31.23,121.47）
        const ll = parseLatLon(rest[rest.length - 1])
        if (ll) {
          const label = cleanPlaceLabel(rest.slice(0, -1).join(' '))
          if (places.length >= PLACE_MAX) return reply('最多 ' + PLACE_MAX + ' 处。先 /perc city del <序号> 删一个。')
          const dup = places.findIndex((p) => p.latitude === ll.latitude && p.longitude === ll.longitude)
          if (dup >= 0) {
            if (label) places[dup] = { ...places[dup], label }
          } else {
            places.push({ label, latitude: ll.latitude, longitude: ll.longitude })
          }
          // 单点字段清掉，避免和名单各说各的；normalizePlaces 在名单非空时本来也不看它们
          configStore.set({ perception: { weather: { places, latitude: null, longitude: null, label: '' } } })
          const verb = dup >= 0 ? (label ? '同一坐标已在名单里，备注已更新' : '这个坐标已经在名单里') : '已添加'
          const note = ll.swapped
            ? '\n（你给的是经度在前。纬度只能在 -90~90，' + rest[rest.length - 1] +
              ' 只能是写反了，已调成 ' + ll.latitude + ',' + ll.longitude + '。）'
            : ''
          return reply(verb + '。角色会按备注区分这些地方：\n' + show() + note + '\n用 /perc preview 看这一轮注入什么。')
        }

        const q = rest.join(' ').trim()
        let list = []
        try {
          list = await geocodePlace(q, w.provider)
        } catch (e) {
          return reply('地名解析失败：' + (e && e.message ? e.message : e) +
            '\n可以直接给坐标：/perc city 家 31.23,121.47')
        }
        if (!list.length) return reply('没找到「' + q + '」。可以直接给坐标：/perc city 家 31.23,121.47')
        const lines = [
          '「' + q + '」找到 ' + list.length + ' 个候选。',
          '⚠️ **不自动采用**：这个源的中文地名解析**很不可靠** ——',
          '　 中文地名经常解析到错地方，正确坐标可能一条都没有。',
          '　 所以**建议直接用坐标**（手机地图上长按地点就能看到）。',
          '候选仅供参考：',
          ''
        ]
        list.forEach((x, i) => {
          lines.push((i + 1) + '. ' + x.name + '　' + [x.admin, x.country].filter(Boolean).join(' ') +
            '　' + x.latitude + ',' + x.longitude)
        })
        lines.push('', '例如：/perc city 家 ' + list[0].latitude + ',' + list[0].longitude)
        return reply(lines.join('\n'))
      }

      if (sub === 'now') {
        const tz = perception.capabilities().timeZone
        return reply('当前时间（' + tz + '）：' + nowText(Date.now(), tz))
      }

      if (sub === 'preview') {
        const sid = chatSessions.current(inbound.userId).id
        const list = history.list(inbound.userId, sid)
        const r = await perception.perceive({ userId: inbound.userId, sessionId: sid, history: list })
        if (!r.text) {
          const why = r.notes && r.notes.length ? r.notes.join('；') : '没有任何能力可用'
          return reply('本轮没有注入感知内容（' + why + '）。')
        }
        const gap = lastSpokeAt(list)
        const lines = ['本轮注入的感知内容（会追加在你这句话之后）：', '', r.text]
        if (gap) {
          const g = gapInfo(gap, Date.now(), perception.capabilities().timeZone)
          lines.push('', '（上次说话 = 你在这个会话里的最后一条消息，' + g.text + '）')
        } else {
          lines.push('', '（这个会话还没有可信时间的用户消息，所以只有「现在」一行；' +
            '从旧客户端导入的历史不带时间，不会拿来当「上次说话」）')
        }
        if (r.notes && r.notes.length) lines.push('未注入：' + r.notes.join('；'))
        return reply(lines.join('\n'))
      }

      // ---- 无参数：状态 ----
      const caps = perception.capabilities()
      const tz = caps.timeZone
      const lines = ['感知模块：' + (caps.enabled ? '开启' : '关闭')]
      for (const c of caps.list) {
        const state = !caps.enabled ? '（随总开关关闭）' : !c.enabled ? '（已关闭）' : c.available ? '（生效中）' : '（不可用：' + c.reason + '）'
        lines.push('· ' + c.name + '：' + (c.kind === 'output' ? '输出' : '输入') + '　' + state)
        if (c.desc) lines.push('　　' + c.desc)
      }
      if (caps.enabled) {
        lines.push('· 时区：' + tz + '　现在是 ' + nowText(Date.now(), tz))
        lines.push('· 间隔提示阈值：' + caps.noticeHours + ' 小时')
        const w = caps.weather || {}
        if (w.provider) {
          const pos = (w.places || []).length
            ? (w.places || []).map((p) => (p.label ? p.label + ' ' : '') + p.latitude + ',' + p.longitude).join('；')
            : '未设置（用 /perc city 设）'
          lines.push('· 天气源：' + w.provider + '　地点：' + pos +
            (Number.isFinite(w.ttlMinutes) ? '　缓存 ' + w.ttlMinutes + ' 分钟' : ''))
        }
      }
      lines.push('', '未接入（已规划，真接好之前不占提示词）：')
      for (const r of caps.roadmap) lines.push('· ' + r.name + '　—　' + r.note)
      lines.push('', '看这一轮实际注入了什么：/perc preview' + (caps.enabled ? '' : '　（先 /perc on）'))
      return reply(lines.join('\n'))
    }
  })

  router.register({
    name: 'now',
    description: '当前时间（按配置时区）',
    run: async ({ services }) => {
      const { perception, reply } = services
      if (!perception) return reply(nowText(Date.now(), DEFAULT_TIME_ZONE))
      const tz = perception.capabilities().timeZone
      return reply('当前时间（' + tz + '）：' + nowText(Date.now(), tz))
    }
  })
}
