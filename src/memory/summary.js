/**
 * 剧情总结：把会话历史压缩成阶段性总结，持久化并可注入上下文。
 */
import { effectiveMaxTokens } from '../providers/catalog.js'

function genId() {
  return 'sm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

const PROMPT =
  '请把下面的角色扮演对话压缩成简洁的剧情总结：保留关键事件、人物关系变化、承诺与重要设定，' +
  '去掉台词原文、寒暄与情绪描写。用中文分点输出，不超过 300 字。'

export function createSummary({ store, providers, logger, config }) {
  const col = store.collection('summaries')

  const api = {
    /** 某用户的总结（最新在前）；不传 userId 则返回全部 */
    list(userId) {
      return col
        .list()
        .filter((s) => !userId || s.userId === userId)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    },
    /** 某会话最近一条总结 */
    latest(userId, sessionId) {
      return api.list(userId).find((s) => s.sessionId === sessionId) || null
    },
    remove(id) {
      col.remove(id)
    },
    /** 清空某用户的总结（不传 userId 则全部清空，内部用） */
    clear(userId = null) {
      const ids = api.list(userId).map((s) => s.id)
      for (const id of ids) col.remove(id)
      return ids.length
    },
    /** 生成并保存总结 */
    async generate({ userId, sessionId, messages }) {
      const text = (messages || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => m.role + '：' + m.content)
        .join('\n')
        .slice(-8000)
      if (!text.trim()) throw new Error('会话内容为空，无法总结')
      const out = await providers.chat({
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
        // 预算：配了就用配置，没配就跟随该模型最高值（上限不是预留，用不到不花钱）
        maxTokens: effectiveMaxTokens(config?.memory?.summaryMaxTokens, providers.activeId)
      })
      const content = (out.text || '').trim()
      if (!content) throw new Error('模型未返回总结内容')
      const obj = { id: genId(), userId, sessionId, content, msgCount: (messages || []).length, createdAt: Date.now() }
      col.put(obj)
      logger.info('已生成总结 ' + obj.id + '（' + content.length + ' 字）')
      return obj
    }
  }
  return api
}
