/**
 * 委托结果回传（后台委托的「后续」）。
 *
 * 设计要求：「委托 agent 干活时可以挂起后台跑，同时回复微信，然后任务执行完成就
 * callback 处理后续的」。于是 `delegate_task` 变成**立刻回执**，真正的结果走这里。
 *
 * 为什么不是「干完直接把结果文本发出去」：
 *   那是一台机器在说话，而这是个角色扮演机器人——她得**用自己的话说**。
 *   所以回调里再走一次模型：带上人设 + 会话历史 + 一条「系统提示（不是对方说的话）」，
 *   让她用一两句话把结果转达对方；要发文件也由她顺手调 `send_file`。
 *
 * ⚠️ 两个硬要求：
 *   1. **绝不能把主流程搞挂**：这里任何异常都只记日志（调用方还会再包一层 try）。
 *   2. **不能谎报**：没做完就如实说没弄成（文案里明说了），别让角色说「做好了」。
 */
import { buildRoleplayMessages, stripInjectedTags, attachTailBlock } from '../roleplay/context.js'
import { getCurrentCharacter } from '../roleplay/character.js'
import { effectiveMaxTokens } from '../providers/catalog.js'

const kb = (n) => (n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB')

/**
 * 给角色看的那条「系统提示」。
 *
 * 为什么写得这么直白（连「不是对方说的话」都写上）：模型很容易把新进来的 user 消息
 * 当成对方刚说的话去回应。这条必须一眼就能看出「这是系统的通知，不是对方在说话」。
 */
function noticeFor(job) {
  const files = (job.meta && job.meta.files) || []
  const list = files.length
    ? '\n产物（都在你的工作目录里，要发给对方就用 send_file，路径直接写文件名）：\n' +
      files
        .slice(0, 8)
        .map((f) => '· ' + f.path + '（' + kb(f.bytes) + '）')
        .join('\n')
    : ''
  return (
    '【系统提示：这不是对方说的话，是你刚才托人做的那件事有结果了】\n' +
    '任务：' +
    job.task +
    '\n' +
    '结果：' +
    (job.ok ? '做完了' : '它没做完') +
    '\n' +
    String(job.text || '（它没有给出结论）').trim() +
    list +
    '\n\n现在用你自己的**一两句话**把这件事告诉对方：口吻照常，' +
    '**不要提「系统 / 后台 / 委托 / 工具」这些字眼**，也不要照抄上面的任务描述；' +
    (job.ok ? '做好了就自然说做好了。' : '没弄成就如实说没弄成，别硬说做好了。') +
    (files.length
      ? '如果对方要的是文件，就用 send_file 发过去——图片想让他直接在聊天里看到就用 as:image，' +
        '要看原图/要看细节就用 as:file，一堆东西先用 zip_files 打包。'
      : '')
  )
}

/**
 * @param {object} deps { services, channel }
 *   services 就是 router 那一套（store/config/logger/providers/agent/history/chatSessions/perception…）
 * @returns {(job:object)=>Promise<void>} 交给 delegator.setCallback
 */
export function createFollowup({ services, channel }) {
  const { logger, config, history, chatSessions, agent, providers } = services

  return async function deliverAgentResult(job) {
    const userId = job.ctx && job.ctx.userId
    if (!userId) {
      logger?.warn?.('[followup] 委托结果没有 userId，无法回传')
      return
    }
    const cfg = providers?.active?.()
    const sayFallback = async (why) => {
      // 退化路径：模型这条路走不通时，至少把结果如实送到，别让用户干等
      const text = `（刚才那件事有结果了：${String(job.text || '它没给出结论').slice(0, 300)}）`
      logger?.warn?.('[followup] ' + why + '，改用直白文案回传')
      await channel.sendReply(userId, text, null).catch((e) => logger?.warn?.('[followup] 发送失败：' + e.message))
    }
    if (!cfg?.apiKey || !cfg?.chatModel || !agent) return sayFallback('没配模型 / 没有 agent 模块')

    const session = chatSessions.current(userId)
    const sid = session.id
    const character = getCurrentCharacter(services.store, userId)
    const prior = history.list(userId, sid)

    try {
      const messages = buildRoleplayMessages({
        store: services.store,
        config,
        character,
        history: prior,
        userText: '',
        userName: session.userName || config.roleplay?.userName || '用户',
        userId
      })
      // ⚠️ 这条**不写进历史**：它不是对方说的话（写进去会污染对话）。
      // 持久化的只有她的回复（下面 history.append）——效果就是「她主动来说了一句」。
      messages.push({ role: 'user', content: noticeFor(job) })

      // 感知（时间等）：活跑了几分钟，「现在几点」很可能已经变了，照旧走尾插
      try {
        const p = await services.perception?.perceive?.({ userId, sessionId: sid, history: prior })
        if (p?.text) attachTailBlock(messages, p.text)
      } catch (e) {
        logger?.warn?.('[followup] 感知块生成失败（忽略）：' + e.message)
      }

      // 工具照常给她（send_file 要用），但「这一轮」的出口走最后已知的 token：
      // 委托跑了几分钟，原来的 context_token 很可能已经过期（过期就退回待发箱，见 send_file）
      const userCtx = {
        userId,
        characterId: character ? character.id : null,
        sessionId: sid,
        contextToken: channel.lastTokenFor?.(userId) || null,
        sent: { count: 0 },
        sendFile: (name, buf) => channel.sendFile(userId, buf, name, channel.lastTokenFor?.(userId) || null),
        // ⚠️ 与 send_file 工具的调用约定一致：`fn(name, buf)`（别写成 `(buf)`，那会把文件名当内容发）
        sendImage: (_name, buf) => channel.sendImage(userId, buf, channel.lastTokenFor?.(userId) || null)
      }

      const llm = config.llm || {}
      const res = await agent.run({
        messages,
        maxTokens: effectiveMaxTokens(llm.maxTokens, providers.activeId),
        temperature: llm.temperature ?? undefined,
        userCtx
      })
      const text = stripInjectedTags(res?.text || '').trim()
      if (!text) return sayFallback('模型没给出话')

      history.append(userId, sid, 'assistant', text)
      logger?.info?.('[followup] 委托结果已转达（' + text.length + ' 字）')
      await channel.sendReply(userId, text, null)
    } catch (e) {
      logger?.warn?.('[followup] 转达失败：' + ((e && e.message) || e))
      await sayFallback('转达时报错').catch(() => {})
    }
  }
}
