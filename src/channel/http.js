/**
 * ClawBot iLink 底层 HTTP 客户端。
 *
 * 协议要点（见 docs/experimental/clawbot-backend-feasibility.md §2）：
 *  - 登录固定 ilinkai.weixin.qq.com，成功后改用响应里的 baseurl
 *  - POST 需带 AuthorizationType / X-WECHAT-UIN / iLink-App-Id / iLink-App-ClientVersion
 *  - HTTP 200 ≠ 业务成功，必须校验响应体 ret
 *  - 协议为社区整理，集中在此文件以便快速适配
 */
import { randomBytes } from 'node:crypto'

export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

export class ChannelError extends Error {
  constructor(message, { httpStatus, ret, errcode, errmsg, path } = {}) {
    super(message)
    this.name = 'ChannelError'
    this.httpStatus = httpStatus
    this.ret = ret
    this.errcode = errcode
    this.errmsg = errmsg
    this.path = path
  }
}

/** X-WECHAT-UIN：随机 uint32 的十进制字符串再做 base64，每次 POST 重新生成 */
export function randomWechatUin() {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/** iLink-App-ClientVersion：语义版本的整数编码，如 2.4.6 -> 132102 */
export function encodeClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((v) => Number.parseInt(v, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export function buildBaseInfo(cfg) {
  return { channel_version: cfg.channelVersion, bot_agent: cfg.botAgent }
}

/**
 * 发起一次 iLink 请求。
 * @returns {Promise<object>} 解析后的 JSON（网络超时抛 ETIMEDOUT）
 */
export async function apiRequest(baseUrl, pathname, options = {}) {
  const { method = 'POST', query, body, token, cfg, timeout = 30000 } = options
  const url = new URL(pathname, baseUrl)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v))
    }
  }

  const headers = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(encodeClientVersion(cfg.appVersion))
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWechatUin()
  }
  if (token) headers.Authorization = `Bearer ${token}`

  // 超时须覆盖 build+headers+读取响应体全过程；不要提前 clearTimeout
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  let res
  let text
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal
    })
    text = await res.text()
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new ChannelError(`请求超时：${pathname}`, { path: pathname })
      e.code = 'ETIMEDOUT'
      throw e
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    throw new ChannelError(`HTTP ${res.status}：${pathname}`, {
      httpStatus: res.status,
      path: pathname,
      errmsg: typeof text === 'string' ? text.slice(0, 300) : undefined
    })
  }
  return json ?? {}
}

/** 校验业务返回：ret 非 0 视为失败；errcode=-14 表示 token 失效 */
export function assertBizOk(resp, pathname) {
  if (resp && typeof resp.ret === 'number' && resp.ret !== 0) {
    const extra = 'errcode=' + (resp.errcode ?? '-') + ' errmsg=' + (resp.errmsg || '-')
    const e = new ChannelError('业务失败 ret=' + resp.ret + ' [' + extra + ']：' + pathname, {
      path: pathname,
      ret: resp.ret,
      errcode: resp.errcode,
      errmsg: resp.errmsg
    })
    if (resp.errcode === -14) e.code = 'TOKEN_INVALID'
    throw e
  }
  return resp
}
