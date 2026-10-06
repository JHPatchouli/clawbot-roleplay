/**
 * 仪表盘：紧凑展示当前生效配置与会话/角色信息。
 * 需要细节时用 /prompt、/provider、/session 等命令。
 */
import { getCurrentCharacter } from '../roleplay/character.js'
import { buildCharacterSystemPrompt } from '../roleplay/prompts.js'
import { PROMPT_LIST } from '../prompts/index.js'
import { redact } from '../logger.js'
import { scopedCollection } from '../storage/scope.js'

const mask = (k) => (k ? redact(k, 4) : '未配置')
const onoff = (b) => (b ? '开' : '关')

export function registerDashboardCommand(router) {
  router.register({
    name: 'dashboard',
    aliases: ['dash', 'panel'],
    description: '仪表盘：当前配置 + 会话 + 角色（紧凑）',
    run: async ({ inbound, services }) => {
      const store = services.store
      const cfg = services.config
      const uid = inbound.userId

      const ch = services.channel
      const providers = services.providers
      const pcfg = providers.active()
      const cap = providers.capability()
      const activeEntry = providers.list().find((p) => p.isActive)
      // 向量配置：与对话 Provider 可以不同源（默认对话 deepseek、向量硅基流动），
      // 所以一律读「解析后的向量配置」，不读当前对话 Provider 的 embedModel
      const emb = (services.embedder && services.embedder.info && services.embedder.info()) || null

      // 多租户：只统计该用户可见（自有 + 共享）的条目
      const chars = scopedCollection(store, 'characters', uid).list()
      const lore = scopedCollection(store, 'lorebook', uid).list()
      // ⚠️ 这里的记忆**不按会话过滤**（全局概览），而 /mem 是会话内的。
      // 两个数字曾经直接打架（仪表盘说「忆 23」、/mem 显示 0），用户看到会以为数据丢了。
      // 所以行里要同时给出「本会话看得到多少」，并对孤儿记忆单独提示。
      const mems = services.memory ? services.memory.list(uid) : []
      const character = getCurrentCharacter(store, uid)

      const cur = services.chatSessions.current(uid) // 先确保存在会话
      const sessions = services.chatSessions.list(uid)
      // 与本会话口径一致（本会话的 + 全局的），即 /mem 列表会列出的条数
      const memsCur = services.memory ? services.memory.list(uid, { sessionId: cur.id }).length : 0
      const aliveSess = new Set(sessions.map((s) => s.id))
      // 所属会话已不存在 = 在任何会话里都看不到（用户自己清不掉，用 /mem orphan）
      const orphanN = mems.filter((m) => m.sessionId && !aliveSess.has(m.sessionId)).length
      const curMsgs = services.history.size(uid, cur.id)
      const totalMsgs = sessions.reduce((n, s) => n + services.history.size(uid, s.id), 0)

      const think = cap && cap.thinking && cap.thinking.params ? JSON.stringify(cap.thinking.params) : '无'
      const thinkShort = (cap && cap.thinking && cap.thinking.params && cap.thinking.params.reasoning_effort)
        ? 'effort=' + cap.thinking.params.reasoning_effort
        : (cap && cap.thinking && cap.thinking.params && cap.thinking.params.enable_thinking ? 'thinking=on' : '无')

      const userName = cur.userName || (cfg.roleplay && cfg.roleplay.userName) || '用户'
      const reply = cfg.reply || {}
      const personaLen = character
        ? buildCharacterSystemPrompt(character, { userName }).length
        : 0
      const byKey = {}
      for (const p of PROMPT_LIST) byKey[p.key] = p.text.length
      const promptBrief =
        '通用' + (byKey.defaultSystem || 0) + ' · 人设动态 · 规范' + (byKey.outputFormat || 0) +
        ' · 记忆' + (byKey.memoryExtract || 0) + '/' + (byKey.memoryRecall || 0)

      const L = []
      L.push('📊 ClawBot 仪表盘')
      L.push('━━ 模型 ━━')
      L.push(providers.activeId + ' · ' + (pcfg && pcfg.chatModel ? pcfg.chatModel : '未配置') + ' · ' + thinkShort)
      L.push('key ' + mask(pcfg && pcfg.apiKey) + ' · 向量源 ' + (emb && emb.providerId ? emb.providerId : '(未配)'))
      L.push('━━ 角色 ━━')
      L.push((character ? character.name : '未选择') + ' · 称呼 ' + userName + (cur.userName ? '(会话)' : '(全局)'))
      const vecReady = services.embedder && services.embedder.ready()
      const sums = services.summary ? services.summary.list(uid).length : 0
      const sharedN = chars.filter((c) => c.shared).length + lore.filter((e) => e.shared).length + mems.filter((m) => m.shared).length
      // 向量：显示解析后的模型名，未就绪时直接点出缺什么
      const embName = emb && emb.model ? emb.model.split('/').pop() : '未配置'
      const vecBrief = vecReady ? embName + ' ' + services.vectorStore.count(uid) + '条' : embName + (emb && !emb.apiKey ? ' 缺 Key' : ' 未就绪')
      L.push(
        '卡 ' + chars.length + ' · 书 ' + lore.length + '(常驻 ' + lore.filter((e) => e.active).length + ') · 忆 ' +
          mems.length + '(本会话 ' + memsCur + ')' + ' · 总结 ' + sums +
          (orphanN ? ' · 孤儿 ' + orphanN + '(/mem orphan)' : '') +
          (sharedN ? ' · 共享 ' + sharedN : '')
      )
      L.push('向量 ' + (vecReady ? '就绪' : '未就绪') + '(' + vecBrief + ') · 自动抽取 每' + ((cfg.memory && cfg.memory.autoExtractEvery) || 0) + '轮(≥' + ((cfg.memory && cfg.memory.extractMinChars) ?? 200) + '字)')
      L.push('━━ 会话 ━━')
      L.push(cur.name + '(' + curMsgs + ') · 共 ' + sessions.length + ' 个/' + totalMsgs + ' 条')
      L.push('━━ 回复 ━━')
      L.push('分段' + onoff(reply.segment !== false) + '(≤' + (reply.maxSegmentsPerReply ?? 10) + '条) · ' + (reply.segmentDelayMs ?? 1200) + 'ms · 回复≤' + ((cfg.llm && cfg.llm.maxTokens) ?? 1024) + 'tok · 导出' + ((cfg.export && cfg.export.mode) || 'file'))
      const lim = ch && ch.limiter ? ch.limiter.stats() : null
      if (lim) L.push('限流额度 ' + lim.quota + '/' + lim.maxPerWindow + ' · 窗口已用 ' + lim.used + ' · 冷却 ' + Math.round(lim.cooldownMs / 1000) + 's')
      const toolsOn = !!(services.tools && services.tools.enabled && services.tools.enabled()) && cfg.tools?.enabled !== false
      const toolsMode = providers.toolsSupported() ? '原生' : '提示词'
      const webP = services.toolStore?.get?.().web || {}
      L.push('工具' + onoff(toolsOn) + '(' + (toolsOn ? toolsMode + ' · 搜索 ' + (webP.provider || '-') : '不参与') + ')')
      L.push('━━ 提示词 ━━')
      L.push(promptBrief + (character ? ' · 组装 ' + personaLen + '字' : ''))
      L.push('━━ 运行 ━━')
      L.push((ch && ch.running ? '在线' : '离线') + ' · 日志' + cfg.logLevel + ' · ' + ((ch && ch.creds && ch.creds.botId) || '-'))
      L.push('')
      L.push('/prompt · /session · /char · /lore · /mem · /provider · /export')

      await services.reply(L.join('\n'))
    }
  })
}
