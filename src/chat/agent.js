/**
 * 工具调用循环（agent loop）。
 *
 * 两种协议共用同一份工具注册表（src/tools/index.js）：
 *   - 原生 function calling：把 tools 交给模型，读 tool_calls，用 role:'tool' 回结果
 *   - 提示词协议：把工具说明附在系统提示词里，模型输出一行 JSON，解析后以 user 消息回结果
 *
 * 设计要点：
 *  1. **不污染角色扮演历史**：工具往返消息只存在于「本轮」的临时消息数组，
 *     持久化进会话历史的仍然只有最终的助手文本（延续「命令流量与角色上下文隔离」的约定）。
 *  2. **自动降级**：原生调用若因 tools 报错（服务商/模型不支持），记录并改用提示词协议重试一次。
 *  3. **封顶**：最多 maxRounds 次工具往返；到顶后要求模型直接作答，避免无限循环烧 token。
 *  4. **静默**：默认不给用户发「正在搜索…」这类提示（会破坏角色沉浸感），
 *     改为每轮通过 onRound 刷新一次「正在输入」状态。
 */

const JSON_STRIP_FENCE = /^```(?:json)?\s*|\s*```$/gi

function tryParseJson(s) {
  try {
    return JSON.parse(s)
  } catch (_) {
    return null
  }
}

/**
 * 从模型输出里解析提示词协议的工具调用。
 * 只认 `{"tool": "...", "args": {...}}`，且工具名必须在注册表里 ——
 * 否则角色扮演里正常的 JSON（如剧情数据）会被误判成工具调用。
 */
export function parseToolCall(text, knownNames) {
  const s = String(text || '')
  const candidates = []
  for (const f of s.match(/```(?:json)?[\s\S]*?```/gi) || []) {
    candidates.push(f.replace(/```(?:json)?/gi, '').trim())
  }
  candidates.push(s.trim())
  const brace = s.match(/\{[\s\S]*\}/)
  if (brace) candidates.push(brace[0])

  for (const c of candidates) {
    const obj = tryParseJson(c)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue
    const name = obj.tool
    if (!name || !knownNames || !knownNames.has(String(name))) continue
    const args = obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {}
    return { name: String(name), args }
  }
  return null
}

/**
 * 这些工具的结果属于「外部内容」：**内容由外面的人控制**。
 *
 * 用途：在本轮给 userCtx 打一个污点标记，下游工具（remember / file_write 这类**会产生持久副作用**的）
 * 据此盖「来源」章 —— 不阻止她做，只是让结果**永远带着出处**。
 *
 * 使用结构标记而不是内容检查：内容检查需要持续枚举变体，而本轮调用过哪些工具是代码已知的事实。
 */
export const UNTRUSTED_TOOLS = new Set(['web_fetch', 'web_search', 'delegate_task'])

/** 最终回复里若残留整段工具 JSON，就不要把它发给用户 */
export function stripToolJson(text) {
  const s = String(text || '').trim()
  const obj = tryParseJson(s.replace(JSON_STRIP_FENCE, '').trim())
  if (obj && typeof obj === 'object' && obj.tool) return ''
  return s
}

/** 是否是「该模型不支持 tools 参数」这类错误（用于触发降级） */
export function isToolsUnsupportedError(e) {
  const m = String(e?.message || '')
  if (!/tool/i.test(m)) return false
  return /(not support|unsupported|unrecognized|unknown|invalid|不支持|无效|unexpected)/i.test(m)
}

export function createAgent({ providers, tools, config, logger }) {
  const enabled = () => Boolean(tools && tools.enabled && tools.enabled() && config.tools?.enabled !== false)
  const maxRounds = () => Math.max(0, Number(config.tools?.maxRounds ?? 3))
  const label = (r) => (r.ok ? 'ok' : 'fail')

  async function runOnce({ messages, maxTokens, temperature, native, knownNames, onRound, userCtx }) {
    let msgs = native ? [...messages] : [...messages, { role: 'system', content: tools.promptBlock() }]
    const max = maxRounds()
    let rounds = 0
    // 工具调用轨迹：随结果返回，由上层存进会话，供 /cot 查看
    // （工具往返消息本身仍然不进入持久化历史，见文件头第 1 条）
    const trace = []
    // 每轮调用的 token 用量：工具往返可能调多次模型，只记最后一次会漏算成本
    const usages = []

    for (;;) {
      if (onRound) {
        try {
          await Promise.resolve(onRound(rounds))
        } catch (_) {
          /* 进度提示失败不影响主流程 */
        }
      }
      const out = await providers.chat({
        messages: msgs,
        maxTokens,
        temperature,
        tools: native ? tools.nativeSchema() : undefined
      })
      if (out.usage) usages.push(out.usage)

      let calls = []
      if (native) {
        calls = out.toolCalls || []
      } else {
        const one = parseToolCall(out.text, knownNames)
        if (one) calls = [{ id: 'p' + rounds, name: one.name, args: one.args }]
      }

      if (!calls.length) {
        return { ...out, mode: native ? 'native' : 'prompt', rounds, trace, usages }
      }

      if (rounds >= max) {
        logger?.warn(`工具调用已达上限 ${max} 轮，要求模型直接作答`)
        // ⚠️ 收尾这一条**绝不能**再把 out.rawToolCalls 回传：
        //    那批工具我们**不打算执行**（已经到上限了），可只要 assistant 消息带了 tool_calls，
        //    服务商就要求后面紧跟每条 tool_call 的 tool 响应 —— 缺了就直接拒绝：
        //    「An assistant message with 'tool_calls' must be followed by tool messages responding
        //      to each 'tool_call_id'」（表现为一句「⚠️ 模型调用失败：模型接口 400」）。
        //    所以连 tool_calls 一起丢掉，只留它已经说出口的那点文本 + 一句催促。
        const nudge = '已达工具调用上限，请直接基于已知信息作答，不要再调用工具。'
        const tail = native
          ? [...(String(out.text || '').trim() ? [{ role: 'assistant', content: out.text }] : []), { role: 'system', content: nudge }]
          : [
              { role: 'assistant', content: out.text },
              { role: 'user', content: '（' + nudge + '不要再输出 JSON。）' }
            ]
        const fin = await providers.chat({ messages: [...msgs, ...tail], maxTokens, temperature })
        if (fin.usage) usages.push(fin.usage)
        return { ...fin, text: stripToolJson(fin.text), mode: native ? 'native' : 'prompt', rounds, capped: true, trace, usages }
      }

      rounds++
      if (native) {
        // 原生：必须把 assistant 的 tool_calls 原样回传，否则服务商会报「tool_call_id 未匹配」
        msgs = [...msgs, { role: 'assistant', content: out.text || '', tool_calls: out.rawToolCalls }]
        for (const c of calls) {
          const t0 = Date.now()
          const r = await tools.run(c.name, c.args, userCtx)
          const ms = Date.now() - t0
          logger?.info(`[tool] ${c.name} ${label(r)} → ${String(r.text).slice(0, 80)}`)
          trace.push({ round: rounds, name: c.name, args: c.args, ok: !!r.ok, ms, chars: String(r.text).length, preview: String(r.text).slice(0, 400) })
          if (userCtx && UNTRUSTED_TOOLS.has(c.name)) userCtx.untrustedThisTurn = true
          msgs = [...msgs, { role: 'tool', tool_call_id: c.id || 'call_' + rounds, content: r.text }]
        }
      } else {
        msgs = [...msgs, { role: 'assistant', content: out.text }]
        for (const c of calls) {
          const t0 = Date.now()
          const r = await tools.run(c.name, c.args, userCtx)
          const ms = Date.now() - t0
          logger?.info(`[tool] ${c.name} ${label(r)} → ${String(r.text).slice(0, 80)}`)
          trace.push({ round: rounds, name: c.name, args: c.args, ok: !!r.ok, ms, chars: String(r.text).length, preview: String(r.text).slice(0, 400) })
          if (userCtx && UNTRUSTED_TOOLS.has(c.name)) userCtx.untrustedThisTurn = true
          msgs = [
            ...msgs,
            {
              role: 'user',
              content: `【工具结果 · ${c.name}】\n${r.text}\n\n（请基于以上结果继续。若还需其他工具，只输出一行 JSON；否则直接回复。）`
            }
          ]
        }
      }
    }
  }

  return {
    enabled,

    /**
     * 执行一次「可能带工具」的对话。
     * @param {Function} [onRound] 每轮开始前的回调（用于刷新 typing）
     * @param {object} [userCtx] { userId, characterId } 本轮是谁在说话，透传给工具
     * @returns {{text, reasoning, usage, model, mode, rounds, capped?, trace}} trace = 工具调用轨迹，供 /cot 查看
     */
    async run({ messages, maxTokens, temperature, onRound, userCtx = null }) {
      if (!enabled()) {
        const out = await providers.chat({ messages, maxTokens, temperature })
        return { ...out, mode: 'off', rounds: 0 }
      }
      const knownNames = new Set(tools.list().map((t) => t.name))
      const native = providers.toolsSupported()
      try {
        return await runOnce({ messages, maxTokens, temperature, native, knownNames, onRound, userCtx })
      } catch (e) {
        if (native && isToolsUnsupportedError(e)) {
          providers.markToolsUnsupported()
          return await runOnce({ messages, maxTokens, temperature, native: false, knownNames, onRound, userCtx })
        }
        throw e
      }
    }
  }
}
