/**
 * 记忆命令：list/search/add/extract/del/clear，并显示向量状态。
 *
 * 记忆是「场景 + 事实 + 维度」：每条带 scene（当时的情境氛围）
 * 与 meaning/confidence，加权出综合分。列表里用 [确信]/[记得]/[模糊] 示意——
 * 这个分**不用于筛选**，只影响召回注入时的口吻。
 */
import { getCurrentCharacter } from '../roleplay/character.js'
import { toExtractText } from '../chat/history.js'
import { memoryBand, renderMemoryDetail, clip } from '../memory/score.js'

/** 一条记忆的短标签：`[确信 0.92]` */
function tag(m) {
  const sc = Number.isFinite(m.score) ? m.score : 0.6
  return '[' + memoryBand(sc).label + ' ' + sc.toFixed(2) + ']'
}

/**
 * 重算「还没有向量」的记忆的向量。
 *
 * 用途：① 导入快照时只带记忆本体、不带向量（见 importer.memoryIds 的注释）；
 *      ② 先前没配向量模型，后来配上了。
 * 这两种情况下这些记忆只能靠关键词召回——换个说法就找不到，而且余弦去重对它无效。
 * 默认只看**当前会话可见的**（与 /mem 列表所见一致），all 则连全局与其他会话一起看。
 */
async function reembedVisible(services, uid, sid, { all = false } = {}) {
  const list = services.memory.list(uid, all ? {} : { sessionId: sid })
  const ids = list.map((m) => m.id)
  const r = await services.memory.reembed(ids, { userId: uid })
  return { ...r, total: ids.length }
}

export function registerMemoryCommands(router) {
  const currentCharId = (services, uid) => {
    const c = getCurrentCharacter(services.store, uid)
    return c ? c.id : null
  }
  /** 当前会话 id（记忆默认按会话隔离，所以每个子命令都得知道自己在哪个会话里） */
  const currentSid = (services, uid) => {
    const s = services.chatSessions && services.chatSessions.current(uid)
    return s ? s.id : null
  }
  /**
   * 发一条**纯通知**：发送失败只记日志，绝不向上抛。
   *
   * 为何要单独抽：导入会话后那条「正在补记忆…」被通道限流卡了
   * 3 分钟，最后抛了「发送失败（可能触发通道限流）」——异常冒到 /import 的 catch，
   * 用户看到「导入失败」，而补记忆**一次都没跑**，之后所有召回全部未命中。
   * 通知发送失败时继续执行实际工作。
   */
  const notify = async (services, text) => {
    try {
      await services.reply(text)
    } catch (e) {
      services.logger.warn('通知消息发送失败（不影响实际工作）：' + e.message)
    }
  }
  const usage =
    '记忆：\n' +
    '/mem [关键词]　列出（本会话的 + 全局的）\n' +
    '/mem show <序号>　看详情（发生时间 / 场景 / 原文出处 / 维度）\n' +
    '/mem add <内容>　新增（算本会话的）\n' +
    '/mem search <关键词>　检索\n' +
    '/mem extract　从当前会话抽取（只取最近一段）\n' +
    '/mem backfill　从当前会话**整段**补记忆（切片抽，导入旧对话后用）\n' +
    '/mem global <序号|all>　把本会话的记忆提升为**全局**（所有会话都能看到）\n' +
    '/mem del <序号>　删除\n' +
    '/mem clear [all]　清空本会话的（加 all 连全局一起清）\n' +
    '/mem vector　向量与重排状态\n' +
    '/mem orphan [clear]　所属会话已被删除的孤儿记忆（它们在任何会话里都看不到）\n' +
    '/mem reembed [all]　给没有向量的记忆补算（导入的旧数据 / 刚配好向量模型时用）\n' +
    '/mem prune　清理孤立向量'

  router.register({
    name: 'mem',
    aliases: ['memory'],
    description: '记忆：list/search/add/extract/backfill/global/del/clear/vector/orphan/reembed/prune',
    run: async ({ args, inbound, services }) => {
      const memory = services.memory
      const reply = services.reply
      const sub = (args[0] || '').toLowerCase()
      // 记忆默认只活在本会话（config.memory.scope，默认 'session'）：
      // 让每个子命令都拿同一份「当前会话」，否则会出现「列表看不到、却能删掉」这类不一致。
      const uid = inbound.userId
      const sid = currentSid(services, uid)
      const live = { userId: uid, sessionId: sid }

      if (sub === 'vector') {
        const emb = services.embedder
        const info = emb.info()
        const cfg = services.config.memory || {}
        const rr = memory.rerankInfo ? memory.rerankInfo() : { ready: false }
        const lines = [
          '检索状态：',
          '· 向量就绪：' + (emb.ready() ? '是' : '否') + '　Provider：' + ((info && info.providerId) || '-') + '　模型：' + ((info && info.model) || '(未配置)'),
          '· 已向量化条目：' + services.vectorStore.count(inbound.userId),
          '· 混合检索：' + (cfg.hybridSearch === false ? '关（只走向量）' : '开（向量 + BM25，RRF 融合）'),
          '· 重排：' + (rr.ready ? '就绪　Provider：' + rr.providerId + '　模型：' + rr.model + '　候选上限 ' + rr.topN : '未配置（按融合顺序）'),
          '',
          '配置：/embed provider <id>　/embed model <名称>　重排见 config.rerank'
        ]
        return reply(lines.join('\n'))
      }

      if (sub === 'show') {
        const list = memory.list(uid, live)
        const i = Number(args[1])
        const m = Number.isInteger(i) && i >= 1 ? list[i - 1] : null
        if (!m) return reply('序号无效，先发 /mem')
        return reply(renderMemoryDetail(m, { index: i, withTime: true }))
      }

      if (sub === 'orphan') {
        // 孤儿记忆：所属会话在本机已经不存在了（会话删了，记忆却留着）。
        // 为何需要这个入口：记忆按会话隔离——这些记忆**在任何一个会话里都看不到**，
        // 所以 /mem 的序号根本指不到它们，用户自己清不掉（只能靠外部脚本）。
        const alive = new Set(services.chatSessions.list(uid).map((s) => s.id))
        const all = memory.list(uid, {})
        const orphans = all.filter((m) => m.sessionId && !alive.has(m.sessionId))
        if ((args[1] || '').toLowerCase() === 'clear') {
          if (!orphans.length) return reply('没有孤儿记忆，无需清理。')
          const bySid = [...new Set(orphans.map((m) => m.sessionId))]
          let memN = 0
          let vecN = 0
          for (const sid of bySid) {
            const r = memory.removeSession(sid, { userId: uid })
            memN += r.memories
            vecN += r.vectors
          }
          return reply(
            '已清理孤儿记忆 ' + memN + ' 条（向量 ' + vecN + ' 条），涉及 ' + bySid.length +
              ' 个已被删除的会话。\n现在还剩 ' + memory.count(uid, {}) + ' 条记忆。'
          )
        }
        if (!orphans.length) return reply('没有孤儿记忆：每条记忆的所属会话都还在。')
        const bySid = [...new Set(orphans.map((m) => m.sessionId))]
        const lines = [
          '孤儿记忆 ' + orphans.length + ' 条（所属会话已不存在，所以它们**在哪个会话里都看不到**）：',
          ...orphans.slice(0, 8).map((m, i) => i + 1 + '. ' + String(m.text).slice(0, 46)),
          '',
          '涉及会话：' + bySid.join('、'),
          orphans.length > 8 ? '（只列前 8 条）' : '',
          '清掉：/mem orphan clear',
          '背景：/session del 以前只删会话记录，记忆与向量会留在库里（现已修）。'
        ].filter(Boolean)
        return reply(lines.join('\n'))
      }

      if (sub === 'reembed') {
        const all = (args[1] || '').toLowerCase() === 'all'
        const before = services.vectorStore.count(uid)
        const r = await reembedVisible(services, uid, sid, { all })
        if (!services.embedder.ready()) {
          return reply(
            '未配置向量模型（/embed provider + /embed model），重算不了。\n' +
            '缺向量的 ' + r.total + ' 条记忆现在只能靠关键词召回（换个说法就找不到）。'
          )
        }
        return reply(
          '向量重算完成（' + (all ? '全部可见记忆' : '本会话可见记忆') + '）：\n' +
          '· 新算 ' + r.embedded + ' 条' + (r.skipped ? '｜已有向量跳过 ' + r.skipped + ' 条' : '') +
          (r.failed ? '｜⚠️ 失败 ' + r.failed + ' 条（看日志）' : '') + '\n' +
          '· 向量总数：' + before + ' → ' + services.vectorStore.count(uid)
        )
      }

      if (sub === 'prune') {
        const removed = memory.pruneOrphans(inbound.userId)
        return reply(
          removed.length
            ? '已清理 ' + removed.length + ' 条孤立向量（记忆早就不在了，向量却还留着）。\n' +
              '产生原因：某个版本的 /import replace 清空记忆时没连向量一起清；现已修正。'
            : '没有孤立向量，无需清理。'
        )
      }

      if (sub === 'add') {
        const text = args.slice(1).join(' ').trim()
        if (!text) return reply('用法：/mem add <内容>')
        // 手工加的也算本会话的：否则 /session new 之后会发现“我自己加的也不见了”
        const obj = await memory.add(text, { userId: uid, sessionId: sid, characterId: currentCharId(services, uid) })
        return reply('已新增记忆（本会话）：' + obj.text.slice(0, 40))
      }

      if (sub === 'global') {
        const a = (args[1] || '').toLowerCase()
        if (!a) return reply('用法：/mem global <序号>　或　/mem global all（把本会话的记忆提升为全局，所有会话都能看到）')
        const mine = memory.list(uid, live)
        let ids = []
        if (a === 'all') ids = mine.filter((m) => m.sessionId).map((m) => m.id)
        else {
          const i = Number(args[1])
          const m = Number.isInteger(i) && i >= 1 ? mine[i - 1] : null
          if (!m) return reply('序号无效，先发 /mem')
          ids = [m.id]
        }
        if (!ids.length) return reply('本会话没有自己的记忆可提升。（全局的无需再提）')
        const n = memory.promote(ids, { userId: uid, sessionId: null })
        return reply('已把 ' + n + ' 条提升为全局（所有会话都能看到）。\n要收回本会话：/mem global 只能提升，收回请用 /mem del 后在本会话重记')
      }

      if (sub === 'extract') {
        const session = services.chatSessions.current(inbound.userId)
        const msgs = services.history.list(inbound.userId, session.id)
        if (!msgs.length) return reply('当前会话还没有内容。')
        // 带真实时间给抽取器（拿不到可信时间的消息不会加前缀），
        // 否则它只能靠正文猜时间——曾经生成过「凌晨一点多」这种无从核实的细节。
        const { text: conv, from, to } = toExtractText(msgs, { maxChars })
        // 抽取只送**最后** maxExtractChars 字。会话一长，这个截断会静默吃掉前面全部内容，
        // 而返回值照样有新增，看不出「只抽了尾巴」——所以这里要说破，并指向 /mem backfill。
        await notify(
          services,
          '正在从当前会话抽取记忆…' +
            (conv.length >= maxChars
              ? '\n（会话已超过 ' + maxChars + ' 字，只取最后一段；要整段补请用 /mem backfill）'
              : '')
        )
        let lines
        try {
          const added = await memory.extractFromConversation(conv, {
            userId: uid,
            sessionId: sid,
            characterId: currentCharId(services, uid),
            // 把人设一并给抽取器，它才能判断某条事实是否「与设定相反」
            character: getCurrentCharacter(services.store, uid),
            sourceFrom: from,
            sourceTo: to
          })
          const lines2 = ['抽取完成：新增 ' + added.length + ' 条']
          // 新增为 0 时说明原因，避免以为是功能坏了
          if (!added.length) {
            const min = services.config.memory?.extractMinChars ?? 200
            lines2.push(conv.length < min ? '（会话文本 ' + conv.length + ' 字 < 阈值 ' + min + ' 字，已跳过以节省 token）' : '（未发现新的可记忆事实，或与已有记忆重复）')
          }
          for (const m of added.slice(0, 10)) {
            lines2.push('· ' + tag(m) + clip(m.text, 50))
          }
          // 回执里**不内联场景**：12 条各带一段「（那时：…）」会把回执挤成一片，
          // 而且按字数硬切会把句子砍在词中间（曾出现「…语气是随」这种断头话）。
          // 场景与原文出处属于详情，去 /mem show 看。
          if (added.length) lines2.push('', '场景与原文出处：/mem show <序号>（序号按 /mem 列表算，不是这里的序号）')
          lines = lines2
        } catch (e) {
          services.logger.warn('抽取失败：' + e.message)
          return notify(services, '抽取失败：' + e.message)
        }
        return notify(services, lines.join('\n'))
      }

      if (sub === 'backfill') {
        const session = services.chatSessions.current(inbound.userId)
        const msgs = services.history.list(inbound.userId, session.id)
        if (!msgs.length) return reply('当前会话还没有内容。')
        if (!memory.backfillFromMessages) return reply('当前版本不支持整段补记忆。')
        const chars = msgs.reduce((a, m) => a + String(m.content || '').length, 0)
        await notify(services, '正在从当前会话（' + msgs.length + ' 条 / ' + chars + ' 字）切片补记忆…')
        let lines
        try {
          const res = await memory.backfillFromMessages(msgs, {
            userId: uid,
            sessionId: sid,
            characterId: currentCharId(services, uid),
            character: getCurrentCharacter(services.store, uid)
          })
          lines = ['补记忆完成：扫描 ' + res.chunks + ' 段（' + res.chars + ' 字），新增 ' + res.added.length + ' 条']
          if (!res.added.length) lines.push('（没找到新的可记忆事实，或都与已有记忆重复）')
          for (const m of res.added.slice(0, 12)) {
            lines.push('· ' + tag(m) + clip(m.text, 50))
          }
          if (res.added.length > 12) lines.push('· …共 ' + res.added.length + ' 条')
          if (res.added.length) lines.push('', '场景与原文出处：/mem show <序号>（序号按 /mem 列表算）')
        } catch (e) {
          // 抽取本身失败才是失败；报错也走 notify，免得“报错发不出去”又被当成另一种失败
          services.logger.warn('补记忆失败：' + e.message)
          return notify(services, '补记忆失败：' + e.message)
        }
        return notify(services, lines.join('\n'))
      }

      if (sub === 'del') {
        const list = memory.list(uid, live)
        const i = Number(args[1])
        const m = Number.isInteger(i) && i >= 1 ? list[i - 1] : null
        if (!m) return reply('序号无效，先发 /mem')
        if (m.shared) return reply('该记忆是共享条目，不能删除。')
        if (!memory.remove(m.id, uid)) return reply('无法删除：该记忆不属于你。')
        return reply('已删除记忆：' + String(m.text || '').slice(0, 40) + (m.sessionId ? '' : '（这条是全局的）'))
      }
      if (sub === 'clear') {
        const all = (args[1] || '').toLowerCase() === 'all'
        // 默认**只清本会话的**：与 /mem 列表所见一致。
        // 若这里默认清全部，用户会以为“看着清了 3 条”，实际把整个账号和全局都清了。
        const n = all ? memory.clear(uid) : memory.clear(uid, { sessionId: sid })
        return reply(
          all
            ? '已清空你的全部 ' + n + ' 条记忆（含向量）；共享记忆与其他用户的未动。'
            : '已清空本会话的 ' + n + ' 条记忆（含向量）；全局记忆与别的会话未动。\n要连全局一起清：/mem clear all'
        )
      }

      // list / search
      const kw = sub === 'search' ? args.slice(1).join(' ') : args.join(' ')
      const list = kw ? memory.search(kw, { userId: uid, limit: 30, sessionId: sid }) : memory.list(uid, live).slice(0, 30)
      if (!list.length) return reply(kw ? '没有包含「' + kw + '」的记忆。' : '本会话暂无记忆。（可用 /mem add 或 /mem extract）')
      const total = memory.count(uid, live)
      const allTotal = memory.count(uid)
      const lines = [
        kw
          ? '记忆（含「' + kw + '」，共 ' + list.length + ' 条）：'
          : '记忆（本会话，共 ' + total + ' 条' + (allTotal > total ? '；账号共 ' + allTotal + ' 条' : '') + '）：'
      ]
      list.forEach((m, i) => lines.push((i + 1) + '. ' + tag(m) + ' ' + String(m.text).slice(0, 60) + (m.shared ? '（共享）' : m.sessionId ? '' : '（全局）')))
      const st = memory.stats(uid, live)
      if (st.total) {
        lines.push(
          '',
          '综合分：确信 ' + st.sure + ' · 记得 ' + st.recall + ' · 模糊 ' + st.fuzzy +
            '（均 ' + st.avg.toFixed(2) + '，带场景 ' + st.scene + '/' + st.total + ' 条）',
          '（这个分不用于筛选，只决定召回注入时的口吻：[确信] 当事实用，[模糊] 只当一点印象）'
        )
      }
      if (st.global) lines.push('其中 ' + st.global + ' 条是全局的（所有会话都看得到）')
      lines.push('', usage)
      await reply(lines.join('\n'))
    }
  })
}
