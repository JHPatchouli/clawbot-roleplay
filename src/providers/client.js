/**
 * OpenAI 兼容客户端：/models、/chat/completions、/embeddings。
 * DeepSeek 与硅基流动共用此实现，差异仅在能力参数（见 catalog.js）。
 */

function normalize(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

async function request(url, { apiKey, method = 'POST', body, timeout = 120000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求模型服务超时')
    throw new Error(`请求模型服务失败：${err.message}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 200)
    throw new Error(`模型接口 ${res.status}：${msg}`)
  }
  return json ?? {}
}

/** 拉取可用模型列表（GET /models） */
export async function listModels({ baseUrl, apiKey }) {
  const data = await request(`${normalize(baseUrl)}/models`, { apiKey, method: 'GET', timeout: 30000 })
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  return list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
}

/**
 * 对话补全（非流式）。
 *
 * 传 `tools` 时走原生 function calling；返回值额外带上 `toolCalls`（归一化）
 * 与 `rawToolCalls`（原样回传，因为下一轮要把它塞回 assistant 消息）。
 *
 * @returns {{text:string, reasoning:string, toolCalls:Array, rawToolCalls:Array, usage:object|null, model:string}}
 */
export async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  extra,
  tools,
  toolChoice
}) {
  const body = { model, messages, stream: false }
  if (temperature != null) body.temperature = temperature
  if (maxTokens != null) body.max_tokens = maxTokens
  // 只在调用方显式传入时附带 tools，避免影响不支持该参数的服务商
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }
  if (extra && typeof extra === 'object') Object.assign(body, extra)
  const data = await request(`${normalize(baseUrl)}/chat/completions`, { apiKey, body })
  const choice = data?.choices?.[0] || {}
  const msg = choice.message || {}
  const raw = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  return {
    text: (msg.content || '').trim(),
    reasoning: (msg.reasoning_content || '').trim(),
    toolCalls: normalizeToolCalls(raw),
    rawToolCalls: raw,
    usage: normalizeUsage(data?.usage),
    model: data?.model || model,
    // finish_reason 原本被丢掉，于是「模型没说话」和「模型被截断」在日志里长得一样。
    // 现在留着：'length' = 撞 max_tokens（另一回事），其余多半是服务商返回了空 content。
    finishReason: choice.finish_reason || null
  }
}

/**
 * 归一化 token 用量，**重点是缓存命中**——各家字段名不一样：
 *   - DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *   - OpenAI 兼容：`prompt_tokens_details.cached_tokens`
 * 归一化之后才能一处统计、一处展示，否则缓存命中率永远是黑盒。
 * @returns {{prompt,completion,total,cacheHit,cacheMiss,hitRate}|null}
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const prompt = num(u.prompt_tokens)
  const completion = num(u.completion_tokens)
  const hit = num(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens)
  let miss = num(u.prompt_cache_miss_tokens)
  if (miss == null && prompt != null && hit != null) miss = Math.max(0, prompt - hit)
  return {
    prompt,
    completion,
    total: num(u.total_tokens),
    cacheHit: hit,
    cacheMiss: miss,
    // 厂商没给缓存字段时是 null（不能当成 0%，否则看起来像「全没命中」）
    hitRate: prompt && hit != null ? hit / prompt : null
  }
}

/** 把各家格式的 tool_calls 归一化为 { id, name, args }（args 解析失败则为空对象） */
export function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((c) => {
      const fn = c?.function || {}
      let args = {}
      try {
        args = fn.arguments ? JSON.parse(fn.arguments) : {}
      } catch (_) {
        args = {}
      }
      return { id: String(c?.id || ''), name: String(fn.name || ''), args }
    })
    .filter((c) => c.name)
}

/** 查询账户余额（DeepSeek：GET /user/balance，路径在 API 根域而非 /v1 下） */
export async function getUserBalance({ baseUrl, apiKey }) {
  const root = normalize(baseUrl).replace(/\/v1$/i, '')
  return request(`${root}/user/balance`, { apiKey, method: 'GET', timeout: 20000 })
}

/** 文本向量（OpenAI 兼容 /embeddings） */
export async function createEmbedding({ baseUrl, apiKey, model, input, dimension }) {
  const body = { model, input }
  if (dimension) body.dimensions = Number(dimension)
  const data = await request(`${normalize(baseUrl)}/embeddings`, { apiKey, body, timeout: 60000 })
  const vecs = (data?.data || []).map((d) => d.embedding)
  return Array.isArray(input) ? vecs : vecs[0]
}

/**
 * 重排（Rerank）。硅基流动等厂商提供 OpenAI 兼容之外的 /rerank 端点：
 *   POST {baseUrl}/rerank  { model, query, documents, top_n }
 *   → { results: [{ index, relevance_score }] }
 * 各家返回字段略有出入（也有用 `relevance_score` / `score` / `index` / `document_id` 的），
 * 这里统一归一化成 [{ index, score }]，拿不到的条目直接丢掉，由调用方兜底。
 */
export async function createRerank({ baseUrl, apiKey, model, query, documents, topN }) {
  const docs = Array.isArray(documents) ? documents.map((d) => String(d ?? '')) : []
  if (!docs.length) return []
  const body = { model, query: String(query ?? ''), documents: docs }
  if (topN) body.top_n = Number(topN)
  const data = await request(`${normalize(baseUrl)}/rerank`, { apiKey, body, timeout: 60000 })
  const arr = data?.results || data?.data || []
  return arr
    .map((r) => {
      const index = Number(r?.index ?? r?.document_id ?? r?.id)
      const score = Number(r?.relevance_score ?? r?.score ?? r?.relevance)
      return { index, score }
    })
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
}
