const SEARCH_URL = 'https://search-codetable.eastmoney.com/codetable/search'
const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
const TENCENT_URL = 'https://qt.gtimg.cn/q='
const QUOTE_FIELDS = 'f43,f57,f58,f60,f46,f44,f45,f169,f170,f86'
const MARKET_PREFIX = { 1: 'sh', 0: 'sz', 116: 'hk' }

export function priceFromRaw(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return number / 100
}

export function normalizeQuote(payload, now = Date.now()) {
  const data = payload?.data
  if (!data?.f57 || !data?.f58) throw new Error('行情数据不完整')
  const price = priceFromRaw(data.f43)
  if (price == null) throw new Error('当前没有有效价格')
  const quoteAt = Number(data.f86) > 0 ? Number(data.f86) * 1000 : now
  return {
    code: String(data.f57),
    name: String(data.f58),
    price,
    previousClose: priceFromRaw(data.f60),
    open: priceFromRaw(data.f46),
    high: priceFromRaw(data.f44),
    low: priceFromRaw(data.f45),
    change: priceFromRaw(data.f169),
    changePercent: Number.isFinite(Number(data.f170)) ? Number(data.f170) / 100 : null,
    quoteAt
  }
}

export function formatQuote(quote) {
  const money = (value) => (value == null ? '—' : value.toFixed(2))
  const signed = (value) => (value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2))
  const time = new Date(quote.quoteAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  return [
    quote.name + '（' + quote.code + '）',
    '最新价：' + money(quote.price),
    '涨跌额：' + signed(quote.change),
    '涨跌幅：' + signed(quote.changePercent) + '%',
    '今开：' + money(quote.open) + '　最高：' + money(quote.high) + '　最低：' + money(quote.low),
    '昨收：' + money(quote.previousClose),
    '行情时间：' + time
  ].join('\n')
}

function parsePayload(text) {
  const raw = String(text || '').trim()
  const json = raw.startsWith('{') || raw.startsWith('[') ? raw : raw.replace(/^[^(]*\(/, '').replace(/\);?$/, '')
  return JSON.parse(json)
}

async function readJson(url, fetchImpl) {
  const response = await (fetchImpl || fetch)(url, { headers: { Referer: 'https://quote.eastmoney.com/' } })
  if (!response.ok) throw new Error('行情接口 HTTP ' + response.status)
  return parsePayload(await response.text())
}

function normalizeSearchRows(data) {
  const direct = data?.QuotationCodeTable?.Data || []
  const table = Array.isArray(data?.result) ? data.result : []
  const nested = Array.isArray(data?.result)
    ? []
    : Object.values(data?.result || {}).flatMap((value) => Array.isArray(value) ? value : [])
  return [...direct, ...table, ...nested].map((row) => {
    const code = String(row?.Code || row?.code || row?.securityCode || '')
    const market = row?.market ?? row?.Market
    return {
      Code: code,
      Name: String(row?.Name || row?.name || row?.securityName || row?.shortName || '').replace(/<[^>]+>/g, ''),
      QuoteID: row?.QuoteID || row?.quoteID || (market != null && code ? market + '.' + code : ''),
      Market: market
    }
  }).filter((row) => row.Code && row.Name && (row.QuoteID || MARKET_PREFIX[row.Market])).slice(0, 5)
}

export async function searchStock(query, fetchImpl) {
  const url = SEARCH_URL + '?keyword=' + encodeURIComponent(String(query || '').trim()) + '&count=5'
  const data = await readJson(url, fetchImpl)
  return normalizeSearchRows(data)
}

export function quoteFromTencent(text, code, now = Date.now()) {
  const fields = String(text || '').split('~')
  if (fields.length < 35 || fields[2] !== code) return null
  const values = [3, 4, 5, 31, 32, 33, 34].map((index) => Number(fields[index]))
  if (values.some((value) => !Number.isFinite(value))) return null
  const parsed = /^\d{14}$/.test(fields[30])
    ? Date.parse(fields[30].replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6+08:00'))
    : NaN
  return {
    code: fields[2],
    name: fields[1],
    price: values[0],
    previousClose: values[1],
    open: values[2],
    change: values[3],
    changePercent: values[4],
    high: values[5],
    low: values[6],
    quoteAt: Number.isFinite(parsed) ? parsed : now
  }
}

async function quoteByTencent(match, fetchImpl, now) {
  const prefix = MARKET_PREFIX[match.Market]
  if (!prefix) return null
  const response = await (fetchImpl || fetch)(TENCENT_URL + prefix + match.Code, {
    headers: { Referer: 'https://gu.qq.com/' }
  })
  if (!response.ok) return null
  const quote = quoteFromTencent(await response.text(), match.Code, now)
  return quote ? formatQuote(quote) : null
}

export async function quoteStock(query, { fetchImpl, now } = {}) {
  const keyword = String(query || '').trim()
  if (!keyword) throw new Error('没有给股票名称或代码')
  const matches = await searchStock(keyword, fetchImpl)
  if (!matches.length && /^\d{6}$/.test(keyword)) {
    for (const market of ['1', '0']) {
      try {
        const payload = await readJson(QUOTE_URL + '?secid=' + market + '.' + keyword + '&fields=' + QUOTE_FIELDS, fetchImpl)
        return formatQuote(normalizeQuote(payload, now))
      } catch (_) {}
    }
  }
  if (!matches.length) throw new Error('没有找到这只股票：' + keyword)
  const exact = matches.find((row) => row.Code === keyword || row.Name === keyword) || matches[0]
  if (matches.length > 1 && exact.Code !== keyword && exact.Name !== keyword) {
    throw new Error('找到多只股票，请改用代码：' + matches.map((row) => row.Name + ' ' + row.Code).join('、'))
  }
  try {
    const payload = await readJson(QUOTE_URL + '?secid=' + encodeURIComponent(exact.QuoteID) + '&fields=' + QUOTE_FIELDS, fetchImpl)
    return formatQuote(normalizeQuote(payload, now))
  } catch (error) {
    const fallback = await quoteByTencent(exact, fetchImpl, now)
    if (fallback) return fallback
    throw error
  }
}
