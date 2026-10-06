/**
 * Provider 目录：内置服务商预设 + 能力规则。
 *
 * 说明：`GET /models` 只返回模型名，不含能力元数据，因此用「服务商规则 + 名称启发式」
 * 推断思考（thinking）能力。
 *
 * 思考方式两类：
 *  - 'params'：通过请求参数控制（DeepSeek 的 reasoning_effort；硅基流动的 enable_thinking/thinking_budget）
 *  - 'model-switch'：通过换模型控制（历史方式，保留以备扩展）
 */

export const PROVIDER_PRESETS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultChatModel: 'deepseek-flash',
    defaultEmbedModel: '',
    balancePath: '/user/balance', // 余额接口（相对 API 根域）
    // flash 支持图像理解（vision），v4-pro 不支持
    supportsVisionModel: 'deepseek-flash',
    // 单次生成上限（max_tokens），以实际验证值为准：
    //   逐档探测本端点 → 262144 收下、524288 报 400
    //   「Invalid max_tokens value, the valid range of max_tokens is [1, 393216]」
    //   老文档写的是 8192，差了两个数量级——只有服务商自己的报错算数。
    maxOutputTokens: 393216,
    thinkingMode: 'params',
    alwaysReasoning: true,
    thinking: {
      effortParam: 'reasoning_effort',
      effortValues: ['low', 'high', 'max'],
      defaultEffort: 'high',
      // 开关：{"thinking": {"type": "enabled"|"disabled"}}
      switchParam: 'thinking',
      switchValues: { on: 'enabled', off: 'disabled' }
    }
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultChatModel: 'Qwen/Qwen3-8B',
    defaultEmbedModel: 'Qwen/Qwen3-Embedding-0.6B',
    thinkingMode: 'params',
    thinking: {
      enableParam: 'enable_thinking',
      budgetParam: 'thinking_budget',
      budgetMin: 128,
      budgetMax: 32768,
      effortParam: 'reasoning_effort',
      effortValues: ['high', 'max'] // 仅部分模型（DeepSeek-V4 / GLM-5.2 等）
    }
  }
}

export function getPreset(id) {
  return PROVIDER_PRESETS[id] || null
}

/**
 * 未知服务商时的保守上限。
 * 为什么不默认写成「最大」：max_tokens 是**按模型**合法的，超过该模型的区间会直接 400。
 * 未验证的服务商使用保守值——宁可少给，也别因为「配置里写着最高值」把整条对话打挂。
 * （换到没登记的服务商后，若仍超限，providers 会从报错里学下真上限并重试，见 parseMaxTokensLimit。）
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/** 某服务商的单次生成上限（max_tokens）；未登记的返回保守默认值 */
export function outputTokenLimit(providerId) {
  const n = Number(getPreset(providerId)?.maxOutputTokens)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * 取「实际发出的生成预算」：
 *   · 配了正整数 → 用它（想收紧时用，如让角色说得短一点）；
 *   · 空 / 0 / 非法 → **跟随该服务商的上限**（null = 跟随，见 config/defaults.js）。
 * 统一在收口处算，免得每个调用点各写一遍 `?? 默认值` 而漏掉 0/NaN 这些边界。
 */
export function effectiveMaxTokens(explicit, providerId) {
  const n = Number(explicit)
  return Number.isFinite(n) && n > 0 ? n : outputTokenLimit(providerId)
}

export function listPresets() {
  return Object.values(PROVIDER_PRESETS)
}

/** 名称启发式：判断某模型是否属于推理模型（可能支持思考参数） */
export function looksReasoning(modelId = '') {
  return /(reason|r1\b|qwq|qwen3|glm-?[45]|deepseek-?v4|deepseek-?flash|thinking|-think)/i.test(modelId)
}

/** 硅基流动中支持 reasoning_effort 的模型 */
export function supportsEffort(providerId, modelId = '') {
  if (providerId === 'deepseek') return true
  return /(deepseek-ai\/DeepSeek-V4|Pro\/deepseek-ai\/DeepSeek-V4|Pro\/zai-org\/GLM-5\.2)/i.test(modelId)
}

/**
 * 是否**可能**支持原生 function calling。
 *
 * GET /models 不返回能力元数据，所以这里只排除「明显不是对话工具模型」的族
 * （嵌入 / 重排 / 语音 / 绘图等），其余一律乐观认为支持；
 * 真正的判定交给运行时降级：一旦带 tools 的请求报错，就记住并改用提示词协议。
 */
export function supportsTools(providerId, modelId = '') {
  if (!modelId) return false
  if (/embedding|rerank|tts|whisper|stable-|flux|kolors|sd3|image/i.test(modelId)) return false
  return true
}

/** 某 Provider 的思考可选项（供命令展示与校验） */
export function thinkingOptions(providerId) {
  const preset = getPreset(providerId)
  if (!preset) return { mode: 'none' }
  return {
    mode: preset.thinkingMode,
    effortValues: preset.thinking?.effortValues || [],
    budgetRange: preset.thinking?.budgetParam ? [preset.thinking.budgetMin, preset.thinking.budgetMax] : null,
    supportsEnableToggle: Boolean(preset.thinking?.enableParam || preset.thinking?.switchParam)
  }
}

/**
 * 计算某 provider+model 的思考能力与将要下发的参数。
 * @returns {{supported:boolean, kind:'none'|'builtin'|'params', params:object|null}}
 */
export function resolveThinking(providerId, modelId, thinking = {}) {
  const preset = getPreset(providerId)
  if (!preset || preset.thinkingMode !== 'params') return { supported: false, kind: 'none', params: null }
  const conf = preset.thinking || {}
  const supported = preset.alwaysReasoning || looksReasoning(modelId)
  if (!supported) return { supported: false, kind: 'none', params: null }

  // 硅基流动风格：enable_thinking 开关 + 可选 budget/effort
  if (conf.enableParam) {
    if (thinking.enabled === false) return { supported: true, kind: 'params', params: { [conf.enableParam]: false } }
    const params = { [conf.enableParam]: true }
    if (thinking.budget) params[conf.budgetParam] = Number(thinking.budget)
    if (thinking.effort && supportsEffort(providerId, modelId)) params[conf.effortParam] = thinking.effort
    return { supported: true, kind: 'params', params }
  }

  // DeepSeek 风格：{"thinking":{"type":"enabled|disabled"}} + reasoning_effort=low|high|max
  if (conf.effortParam) {
    const enabled = thinking.enabled !== false
    const params = {}
    if (conf.switchParam) params[conf.switchParam] = { type: enabled ? conf.switchValues.on : conf.switchValues.off }
    if (enabled) params[conf.effortParam] = thinking.effort || conf.defaultEffort || 'high'
    return { supported: true, kind: 'params', params }
  }

  return { supported: false, kind: 'none', params: null }
}
