/**
 * Provider 门面：读取/切换/发现模型，组装思考参数并调用。
 */
import { getPreset, listPresets, resolveThinking, looksReasoning, supportsEffort, supportsTools, thinkingOptions, outputTokenLimit } from './catalog.js'
import {
  listModels as apiListModels,
  chatCompletion as apiChat,
  createEmbedding as apiEmbed,
  getUserBalance
} from './client.js'

/**
 * 「模型一个字都没说」的判定
 *
 * 现象：收到的回复是占位文案 `（模型未返回内容）`，日志里那行是
 *   `模型返回 text=9字 思考链=163字 工具调用=0次` —— 9 字就是占位文案自己的长度，
 *   而 `tokens 输出=106` 远小于 `maxTokens=1024`。**不是被截断，是服务商真的返回了空 content。**
 *   DeepSeek 的 JSON 模式早有「有概率返回空 content」的记载（见 chatJson 注释），
 *   但**普通对话这条路什么都没做**：空内容被原样当成回复发给了用户。
 *
 * 三个条件必须一起看，少一个都会误伤正常流程：
 *   · 没有文本 —— 这是要修的；
 *   · 没有 tool_calls —— 模型「只调工具不说话」是合法的一轮，重试会打断工具链；
 *   · finish_reason 不是 length —— 撞上限是另一回事（不加预算的重试必然同样失败）。
 */
export function isEmptySpeech(out) {
  if (!out || out.text) return false
  if (out.toolCalls && out.toolCalls.length) return false
  if (out.finishReason === 'length') return false
  return true
}

/** 空内容时追加的催促。放在消息末尾（与 agent 的「已达上限请直接作答」同样是尾部 system 消息）。 */
const EMPTY_SPEECH_NUDGE = '（刚才没有输出任何内容。请直接输出你要说的话。）'

/**
 * 从服务商 400 的报错里读出 `max_tokens` 的真上限。
 * DeepSeek 会写：`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`。
 * 为什么值得解析：`max_tokens` 是**按模型**合法的，写大了整个请求直接 400；
 * 而配置里那个值换服务商/换模型时不会自动跟着变——服务商自己报的数最靠得住。
 * 只认两种写法，避免把别的数字当成上限（宁可不学，也不要学错）。
 */
export function parseMaxTokensLimit(msg) {
  const s = String(msg || '')
  const range = /max_tokens[^\d]*\[[^,\]]*,\s*(\d+)\s*\]/.exec(s)
  if (range) return Number(range[1])
  const atMost = /(?:at most|最多)\s*(\d+)\s*(?:completion\s*)?tokens?/i.exec(s)
  if (atMost) return Number(atMost[1])
  return null
}

export function createProviders({ providerStore, logger }) {
  const requireConf = (id) => {
    const cfg = providerStore.get(id)
    if (!cfg?.baseUrl) throw new Error(`Provider ${id} 未配置 Base URL`)
    if (!cfg?.apiKey) throw new Error(`Provider ${id} 未配置 API Key，请用 /key set ${id} <key>`)
    return cfg
  }

  // 运行时降级记录：「provider|model」→ 不支持原生 function calling
  const toolsUnsupported = new Set()
  // 运行时学到的「该模型 max_tokens 上限」：「provider|model」→ N（服务商报错里带的真上限）
  const learnedTokenLimits = new Map()

  const api = {
    listPresets,
    get activeId() {
      return providerStore.activeId
    },
    active() {
      return providerStore.get()
    },
    list() {
      return providerStore.list().map((p) => ({ ...p, presetLabel: getPreset(p.id)?.label || p.id, isActive: p.id === providerStore.activeId }))
    },
    setActive(id) {
      return providerStore.setActive(id)
    },
    setKey(id, key) {
      return providerStore.update(id, { apiKey: String(key || '').trim() })
    },
    setModel(id, model) {
      return providerStore.update(id, { chatModel: String(model || '').trim() })
    },
    setEmbedModel(id, model) {
      return providerStore.update(id, { embedModel: String(model || '').trim() })
    },
    setThinking(id, patch) {
      return providerStore.update(id, { thinking: patch })
    },
    models(id = providerStore.activeId) {
      return providerStore.get(id)?.models || []
    },

    /** 发现可用模型并缓存 */
    async discover(id = providerStore.activeId) {
      const cfg = requireConf(id)
      const models = await apiListModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
      providerStore.setModels(id, models)
      return models
    },

    /** 当前模型的能力说明（供 /thinking 展示） */
    capability(id = providerStore.activeId) {
      const cfg = providerStore.get(id)
      const preset = getPreset(id)
      const thinking = resolveThinking(id, cfg?.chatModel, cfg?.thinking)
      return {
        providerId: id,
        model: cfg?.chatModel,
        thinkingMode: preset?.thinkingMode || 'none',
        thinking,
        reasoningModel: looksReasoning(cfg?.chatModel),
        effortSupported: supportsEffort(id, cfg?.chatModel),
        options: thinkingOptions(id)
      }
    },

    /** 思考可选项 */
    options(id = providerStore.activeId) {
      return thinkingOptions(id)
    },

    /** 查询账户余额（DeepSeek 支持） */
    async balance(id = providerStore.activeId) {
      const cfg = requireConf(id)
      const preset = getPreset(id)
      if (!preset?.balancePath) throw new Error(`${id} 未提供余额查询接口`)
      return getUserBalance({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
    },

    /**
     * 是否可用原生 function calling。
     * 乐观判断 + 运行时降级：一旦带 tools 的请求报错就记住，后续直接走提示词协议。
     */
    toolsSupported(id = providerStore.activeId) {
      const cfg = providerStore.get(id)
      if (!cfg) return false
      if (toolsUnsupported.has(id + '|' + (cfg.chatModel || ''))) return false
      return supportsTools(id, cfg.chatModel)
    },

    /** 记录「该模型不支持 tools」并返回签名（供日志展示） */
    markToolsUnsupported(id = providerStore.activeId) {
      const cfg = providerStore.get(id)
      const sig = id + '|' + (cfg?.chatModel || '')
      toolsUnsupported.add(sig)
      logger.warn('已记录 ' + sig + ' 不支持原生 function calling，后续改用提示词协议')
      return sig
    },

    /** 使用当前 Provider 对话（extra 可覆盖/追加请求参数，如 response_format） */
    async chat({ messages, temperature, maxTokens, id = providerStore.activeId, extra, tools, toolChoice } = {}) {
      const cfg = requireConf(id)
      const thinking = resolveThinking(id, cfg.chatModel, cfg.thinking)
      const merged = { ...(thinking.params || {}), ...(extra || {}) }
      const finalExtra = Object.keys(merged).length ? merged : undefined
      logger.debug(`调用模型 ${id}/${cfg.chatModel} thinking=${JSON.stringify(thinking)} tools=${Array.isArray(tools) ? tools.length : 0}`)
      // max_tokens 是**按模型**合法的：超过该模型的区间直接 400。
      // 所以先按「本服务商的上限」（catalog 中登记的值）夹一层，
      // 这样配置里写最大值也不会把换服务商后的对话打挂（最多只是没放宽）。
      const sig = id + '|' + cfg.chatModel
      const limit = learnedTokenLimits.get(sig) || outputTokenLimit(id)
      let budget = maxTokens == null ? null : Math.min(Number(maxTokens) || 0, limit) || null
      const call = (msgs) =>
        apiChat({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.chatModel,
          messages: msgs,
          temperature,
          maxTokens: budget,
          extra: finalExtra,
          tools,
          toolChoice
        })

      let out
      try {
        out = await call(messages)
      } catch (e) {
        // 夹过之后还超限（未登记的服务商/新模型）：服务商报错里带着真上限，学下来重试一次。
        const real = parseMaxTokensLimit(e.message)
        if (!real || !budget || budget <= real) throw e
        learnedTokenLimits.set(sig, real)
        logger.warn(`max_tokens=${budget} 超出该模型上限，服务商报的上限是 ${real}，按上限重试`)
        budget = real
        out = await call(messages)
      }
      // 空内容重试一次（见 isEmptySpeech 的说明）。
      // JSON 模式不走这条路：那边有自己的一套（撞上限要翻倍预算），
      // 而且催促的措辞是给「说人话」用的，塞进抽取请求里是干扰。
      if (!extra?.response_format && !out.text && !(out.toolCalls || []).length) {
        if (out.finishReason === 'length') {
          // 撞上限导致的空内容：**不加预算的重试毫无意义**（同样的上限必然同样被吃满）
          logger.warn(
            `模型 content 为空且 finish=length（思考 ${out.reasoning.length} 字吃满了 max_tokens=${maxTokens ?? '默认'}）——重试无用，需要提高预算`
          )
        } else {
          logger.warn(
            `模型返回空内容（finish=${out.finishReason || '未知'} 思考=${out.reasoning.length}字），催促后重试 1 次`
          )
          out = await call([...messages, { role: 'system', content: EMPTY_SPEECH_NUDGE }])
          if (isEmptySpeech(out)) {
            logger.warn(
              `催促后仍为空内容（finish=${out.finishReason || '未知'} 思考=${out.reasoning.length}字）；思考片段：` +
                out.reasoning.slice(0, 200)
            )
          }
        }
      }
      return out
    },

    /**
     * JSON 模式对话：response_format=json_object。
     * 文档提示该模式有概率返回空 content，故带重试。
     *
     * ⚠️ 还有一种失败不是「有概率」而是**必然**：
     *   思考型模型的**推理内容也计入 completion**。输入一长，推理先把 maxTokens 吃满，
     *   于是 content 要么为空、要么被截断成半截 JSON —— 而**原样重试毫无意义**，
     *   同样的上限必然得到同样的截断（原来的重试就是这种无用重试）。
     *   同一段 2061 字输入：maxTokens=900 时 completion 正好 900、JSON 解析失败；
     *   把输入缩到 644 字就一切正常（completion 802）。
     *   所以一旦发现「completion 顶到上限」，就**把预算翻倍**再试。
     *   翻倍一直做到 `maxBudget`（不传就是**该服务商的生成上限**，由 catalog 登记）——
     *   只翻一次是不够的：补记忆的长片段在翻到 4000 后仍然被思考吃满，
     *   那片就白跑了（限额内“工作确实被截断”，翻倍是找回它们的唯一办法）。
     *   注意单次重试仍然受 `retries` 限制，成本是有界的。
     *   注意 maxTokens 是**上限不是预留**——没用到的部分不额外花钱，
     *   所以平时把预算设宽一点是免费的，撞上限才是真的白花钱。
     * @returns {{ text, reasoning, usage, json: object|null, escalated: number }}
     */
    async chatJson({ messages, maxTokens = 800, id, retries = 2, escalate = true, maxBudget } = {}) {
      let budget = maxTokens
      // 翻倍的终点 = 该服务商的生成上限（登记在 catalog 中），不再写死 8000：
      // 写死的话「把预算翻到上限」永远达不到真上限，长片照样会被思考吃满。
      const ceiling = maxBudget ?? outputTokenLimit(id ?? providerStore.activeId)
      let escalated = 0
      let last = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        const out = await api.chat({
          messages,
          maxTokens: budget,
          id,
          extra: { response_format: { type: 'json_object' } }
        })
        last = out
        const text = (out.text || '').trim()
        if (text) {
          try {
            return { ...out, json: JSON.parse(text), escalated }
          } catch (_) {
            /* 解析不了：可能是被截断，也可能模型就是没按 JSON 说 → 交给下面的判断 */
          }
        }
        // 撞上限 = completion 正好顶到 budget → 推理吃满了预算，不加预算重试必然同样失败
        const used = Number(out.usage && out.usage.completion)
        const capped = Number.isFinite(used) && used > 0 && used >= budget
        if (escalate && capped && attempt < retries && budget < ceiling) {
          const next = Math.min(budget * 2, ceiling)
          logger.warn(
            'JSON 模式撞上 max_tokens 上限（completion ' + used + ' = 上限 ' + budget +
              '，多为思考过程吃满预算导致 content 被截断）；把预算提到 ' + next + ' 再试'
          )
          budget = next
          escalated = next
          continue
        }
      }
      // ⚠️ 最后一次的 text/reasoning/usage 必须留下来。
      // 以前这里直接返回空壳（text:''、usage:null），导致
      // 「模型返回了半截 JSON」和「模型什么都没说」在日志里长得一模一样——出问题根本查不出来。
      return { ...(last || { text: '', reasoning: '', usage: null }), json: null, escalated }
    },

    async embed(input, id = providerStore.activeId) {
      const cfg = requireConf(id)
      if (!cfg.embedModel) throw new Error('未配置向量模型（/embed model <名称>）')
      return apiEmbed({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.embedModel, input })
    }
  }
  return api
}
