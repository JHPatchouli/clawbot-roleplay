/**
 * 感知 · 天气（感知管理模块的第二个能力）
 *
 * 为什么需要这个能力：
 *   没有天气数据时，模型可能反复编造不同的天气描述。
 *   当时的解法是**只禁止回答**（「你无从知道的外部事实，不知道就说不知道」）。
 *   这一条把解法换成**提供真实数据** —— 编造的根因是没数据，堵嘴只是权宜。
 *
 * ⚠️ 为什么位置**必须显式配置**，绝不用服务器 IP 自动定位：
 *   服务器 IP 定位得到的是机房所在城市，不是用户所在城市，
 *   还说得理直气壮。**比不说更糟。**
 *
 * ⚠️ 为什么必须缓存 + 后台刷新（这一条决定了能不能用）：
 *   `perceive()` 是在**拼提示词之前 await** 的（见 router.js），
 *   所以一个慢查询会拖慢**每一轮**回复。Open-Meteo 冷查 ~1s，超时上限我们给 5s。
 *   策略：命中缓存直接用；过期就用**旧值**并触发后台刷新；连旧值都没有才同步查一次。
 *   再加上失败冷却，避免 API 挂了以后每轮都白等 5 秒。
 *
 * ⚠️ 精度说明（精度有限）：同一经线间距 1.5km 两点数值**完全相同**，
 *   5km 才差 0.4℃ ⇒ 有效分辨率约 5~10km，**做不到"街道级"**。
 *   更反直觉的是：**换模型能差 1.3℃**（同一坐标 icon 21.7 vs 默认 20.4），
 *   比换街道差得多。所以提升精度该换数据源，不该换坐标。
 *   要更细只能上国内商用源（和风格点 ~1-3km / 彩云雷达外推的降水），
 *   已留成可插拔 provider —— 见下面 PROVIDERS。
 */
import { DEFAULT_TIME_ZONE } from './time.js'

/** WMO 天气码 → 中文（Open-Meteo 用的就是这套） */
export function wmoText(code) {
  // ⚠️ 必须先把 null/''/undefined 挡掉：`Number(null) === 0`，不挡的话
  //    空值会被当成码 0（晴）—— 把「没有数据」渲染成「大晴天」，是最坏的一类错误。
  if (code == null || code === '') return ''
  const c = Number(code)
  if (!Number.isFinite(c)) return ''
  if (c === 0) return '晴'
  if (c === 1) return '晴间多云'
  if (c === 2) return '多云'
  if (c === 3) return '阴'
  if (c === 45 || c === 48) return '雾'
  if (c >= 51 && c <= 57) return '毛毛雨'
  if (c === 61 || c === 63 || c === 65) return '雨'
  if (c === 66 || c === 67) return '冻雨'
  if (c >= 71 && c <= 77) return '雪'
  if (c >= 80 && c <= 82) return '阵雨'
  if (c === 85 || c === 86) return '阵雪'
  if (c === 95) return '雷阵雨'
  if (c >= 96 && c <= 99) return '雷暴伴冰雹'
  return '未知天况'
}

/**
 * 各 provider 的取数实现。
 *
 * 加一家新源 = 往这里加一条 + 在 `available()` 里声明它需要什么字段。
 * ⚠️ 需要 key 的源**不要把 key 写进仓库**：走运行时配置（`/perc weather key <key>`），
 *   密钥只落盘到容器内的 data/。
 */
export const PROVIDERS = {
  'open-meteo': {
    label: 'Open-Meteo',
    needKey: false,
    note: '免费、无需 key；全球模式，有效分辨率约 5~10km',
    async fetch({ latitude, longitude, timeZone, timeoutMs, pastDays = 1, forecastDays = 3 }) {
      // past_days=1 把昨天并进同一次预报请求。它与历史接口的昨日高低温、降水一致，
      // 不必再打 archive-api（那一家的降水概率还是 null）。
      const past = Math.min(7, Math.max(0, Number(pastDays) || 0))
      const ahead = Math.min(7, Math.max(1, Number(forecastDays) || 1))
      const u =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code' +
        `&timezone=${encodeURIComponent(timeZone || DEFAULT_TIME_ZONE)}` +
        `&forecast_days=${ahead}&past_days=${past}`
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const r = await fetch(u, { signal: ctl.signal })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        const cur = j.current || {}
        const d = j.daily || {}
        const days = []
        const dates = Array.isArray(d.time) ? d.time : []
        for (let i = 0; i < dates.length; i++) {
          days.push({
            date: dates[i],
            code: Array.isArray(d.weather_code) ? d.weather_code[i] : null,
            high: Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max[i] : null,
            low: Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min[i] : null,
            rain: Array.isArray(d.precipitation_sum) ? d.precipitation_sum[i] : null,
            rainChance: Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max[i] : null
          })
        }
        const today = days[past] || days[0] || {}
        return {
          at: Date.now(),
          code: cur.weather_code,
          temp: cur.temperature_2m,
          feels: cur.apparent_temperature,
          humidity: cur.relative_humidity_2m,
          wind: cur.wind_speed_10m,
          precipitation: cur.precipitation,
          high: today.high ?? null,
          low: today.low ?? null,
          rainChance: today.rainChance ?? null,
          days,
          todayIndex: Math.min(past, Math.max(0, days.length - 1)),
          raw: j
        }
      } finally {
        clearTimeout(timer)
      }
    },

    /**
     * 城市名 → 候选坐标。
     * ⚠️ 中文地名的第一条候选经常是错地方。
     *   所以调用方**必须把候选列出来给人确认**，不能悄悄采用第一条。
     */
    async geocode(name, { timeoutMs = 5000 } = {}) {
      const u =
        'https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(name) +
        '&count=5&language=zh&format=json'
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const r = await fetch(u, { signal: ctl.signal })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        return (j.results || []).map((x) => ({
          name: x.name,
          admin: [x.admin1, x.admin2].filter(Boolean).join(' '),
          country: x.country || x.country_code || '',
          latitude: x.latitude,
          longitude: x.longitude,
          timezone: x.timezone || ''
        }))
      } finally {
        clearTimeout(timer)
      }
    }
  }

  // ── 以下为预留：填了 key/host 就能用，代码不用重构 ──
  // 'qweather': { label: '和风天气', needKey: true, note: '国内格点天气，约 1~3km；需专属 API Host + key', fetch: ... },
  // 'caiyun':   { label: '彩云天气', needKey: true, note: '雷达外推，降水可到公里级/分钟级；需 token', fetch: ... }
}

const num = (v, digits = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : null)

/**
 * 坐标安全转换：拿不到有效数字就返回 null。
 * ⚠️ **不能用 `Number(v)` 直接判**：`Number(null) === 0`、`Number('') === 0`，
 *   而默认配置里 latitude/longitude 就是 `null` —— 不挡的话「没配位置」会被当成
 *   「位置是 (0,0)」（几内亚湾的零点岛），于是真的去查、拿回一个 HTTP 400，
 *   而 `/perc` 报的是「取数失败」而不是「未设置位置」。实际运行中曾经出错。
 */
export function toCoord(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 当前 provider 支持的 provider id 列表（供 /perc 展示） */
export function providerIds() {
  return Object.keys(PROVIDERS)
}

/** 备注上限：它会进每一轮提示词，太长只会占位置 */
export const PLACE_LABEL_MAX = 12
/** 同时查几个地方：每多一个地方，冷启动就多一次网络往返 */
export const PLACE_MAX = 8

/**
 * 备注清洗。
 * 备注是**给角色看的**（「家」「公司」），所以要能读；
 * 但注入文本是按行切的，备注里的换行会把一行天气拆成两行，必须去掉。
 */
export function cleanPlaceLabel(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLACE_LABEL_MAX)
}

/**
 * 把配置归一成地点名单。
 *
 * 两种来源，**名单优先**：
 *   · `places: [{ label, latitude, longitude }]` —— 家、公司可以同时在
 *   · 旧的单点 `latitude/longitude/label` —— 升级前已经设过的位置，不能丢
 * 坐标无效的条目直接丢掉（不查、不渲染），避免一条坏数据把整块天气拖垮。
 */
export function normalizePlaces(c = {}) {
  const out = []
  const push = (label, latitude, longitude) => {
    const lat = toCoord(latitude)
    const lon = toCoord(longitude)
    if (lat == null || lon == null) return
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return
    out.push({ label: cleanPlaceLabel(label), latitude: lat, longitude: lon })
  }
  if (Array.isArray(c.places)) {
    for (const p of c.places) push(p && p.label, p && p.latitude, p && p.longitude)
  }
  if (!out.length) push(c.label, c.latitude, c.longitude)
  return out.slice(0, PLACE_MAX)
}

/**
 * 解析位置参数：认 `lat,lon`（半/全角逗号都行）。
 *
 * 只在**能确定写反了**时才自动调换：纬度只能在 -90~90，所以第一个数超出这个范围、
 * 第二个数却在范围内，就只可能是「经度,纬度」（地图 App 常见的写法）。
 * 两个数都在范围内时**不猜**——（23,113）和另一个两个数都在范围内的点都合法，
 * 调换会悄悄查错地方。
 * @returns {{latitude:number, longitude:number, swapped:boolean}|null}
 */
export function parseLatLon(s) {
  const m = String(s == null ? '' : s)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/)
  if (!m) return null
  let latitude = Number(m[1])
  let longitude = Number(m[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  let swapped = false
  const latOk = latitude >= -90 && latitude <= 90
  const lonOk = longitude >= -180 && longitude <= 180
  if (!latOk && Math.abs(latitude) <= 180 && longitude >= -90 && longitude <= 90) {
    const tmp = latitude
    latitude = longitude
    longitude = tmp
    swapped = true
  } else if (!latOk || !lonOk) {
    return null
  }
  return { latitude, longitude, swapped }
}

/** 用指定 provider 做地名解析；不支持则返回空数组 */
export async function geocodePlace(name, providerName, opts) {
  const p = PROVIDERS[providerName] || PROVIDERS['open-meteo']
  if (typeof p.geocode !== 'function') return []
  return p.geocode(name, opts)
}

const DAY_NAME = ['昨天', '今天', '明天', '后天']

/** 某一天的一行。昨天用实际降水量（概率对已经发生的事没意义），其余用降水概率。 */
function dayLine(day, index, todayIndex) {
  if (!day) return null
  // ⚠️ 不能先 Number() 再交给 num()：Number(null) === 0，缺测会被渲染成 0.0℃。
  if (day.high == null || day.high === '' || day.low == null || day.low === '') return null
  const hi = num(day.high)
  const lo = num(day.low)
  if (!hi || !lo) return null
  const offset = index - todayIndex
  const name = offset >= -1 && offset <= 2 ? DAY_NAME[offset + 1] : String(day.date || '').slice(5)
  const sky = wmoText(day.code)
  let rain = ''
  if (offset < 0) {
    const mm = Number(day.rain)
    if (Number.isFinite(mm)) rain = mm > 0 ? '，降水 ' + num(mm) + 'mm' : '，无降水'
  } else {
    // ⚠️ 先挡 null/''：Number(null) === 0，否则「没有概率」会变成「降水概率 0%」。
    const chance = day.rainChance
    if (chance != null && chance !== '' && Number.isFinite(Number(chance))) {
      rain = '，降水概率 ' + Math.round(Number(chance)) + '%'
    }
  }
  return name + ' ' + lo + '~' + hi + '℃' + (sky ? ' ' + sky : '') + rain
}

/**
 * 把一份数据渲染成注入文本（不含 <perception> 标签，标签由感知管理模块统一加）。
 * 多个地点时每处一块，备注写在括号里 —— 角色靠这个区分「家」和「公司」。
 * 除了此刻，还带昨天和未来几天：对方问「昨天热不热 / 明天要不要带伞」时才用得上。
 */
export function renderWeather(d, { label } = {}) {
  if (!d || !Number.isFinite(Number(d.temp))) return null
  const where = label ? '（' + label + '）' : ''
  const lines = []
  const feels = num(d.feels)
  const hum = Number.isFinite(Number(d.humidity)) ? Math.round(Number(d.humidity)) + '%' : null
  lines.push(
    '天气' + where + '：' + wmoText(d.code) + '，' + num(d.temp) + '℃' +
    (feels ? '（体感 ' + feels + '℃）' : '') +
    (hum ? '，湿度 ' + hum : '')
  )
  const days = Array.isArray(d.days) ? d.days : []
  const todayIndex = Number.isInteger(d.todayIndex) ? d.todayIndex : 0
  if (days.length) {
    for (let i = 0; i < days.length; i++) {
      const line = dayLine(days[i], i, todayIndex)
      if (line) lines.push(line)
    }
  } else {
    const hi = num(d.high)
    const lo = num(d.low)
    const rain = Number.isFinite(Number(d.rainChance)) ? Math.round(Number(d.rainChance)) : null
    if (hi && lo) lines.push('今日 ' + lo + '~' + hi + '℃' + (rain != null ? '，降水概率 ' + rain + '%' : ''))
    else if (rain != null) lines.push('今日降水概率 ' + rain + '%')
  }
  return lines.join('\n')
}

/**
 * 天气感知能力。
 * @param {object} deps
 */
export function createWeatherSense({ configStore, config, logger, now = () => Date.now() } = {}) {
  const cfg = () => ((configStore?.get?.() || config || {}).perception || {}).weather || {}

  // 每个地点一份缓存：家过期了不该把公司的缓存也丢掉
  const slots = new Map()

  const providerOf = () => PROVIDERS[cfg().provider] || PROVIDERS['open-meteo']

  const slotKey = (place) => {
    const c = cfg()
    return [c.provider || 'open-meteo', place.latitude, place.longitude, c.timeZone || ''].join('|')
  }

  const slotOf = (key) => {
    let s = slots.get(key)
    if (!s) {
      // ⚠️ lastError.at 用 null 而不是 0：测试时钟从 0 起时，0 会被当成「刚失败过」
      s = { at: 0, data: null, inflight: null, lastError: { at: null, msg: '' } }
      slots.set(key, s)
    }
    return s
  }

  /** 真正去取一个地点；同一地点并发去重，不同地点互不等待 */
  const fetchPlace = (place) => {
    const key = slotKey(place)
    const slot = slotOf(key)
    if (slot.inflight) return slot.inflight
    const c = cfg()
    const p = providerOf()
    slot.inflight = (async () => {
      try {
        const d = await p.fetch({
          latitude: place.latitude,
          longitude: place.longitude,
          timeZone: c.timeZone || DEFAULT_TIME_ZONE,
          apiKey: c.apiKey || '',
          pastDays: c.pastDays,
          forecastDays: c.forecastDays,
          timeoutMs: Math.max(1000, Number(c.timeoutMs) || 5000)
        })
        slot.at = now()
        slot.data = d
        slot.lastError = { at: null, msg: '' }
        return d
      } catch (e) {
        slot.lastError = { at: now(), msg: e && e.message ? e.message : String(e) }
        logger?.warn?.('[perc] weather 取数失败（' + (place.label || key) + '）：' + slot.lastError.msg)
        return null
      } finally {
        slot.inflight = null
      }
    })()
    return slot.inflight
  }

  return {
    id: 'weather',
    name: '天气',
    kind: 'input',
    desc: '一个或多个地点的此刻、昨天与未来几天天气（每处可备注；位置需显式配置）',

    enabled: () => cfg().enabled !== false,

    available: () => {
      const c = cfg()
      const places = normalizePlaces(c)
      if (!places.length) {
        return { ok: false, reason: '未设置位置（用 /perc city <备注> <lat,lon> 添加，可加多个）' }
      }
      const p = providerOf()
      if (p.needKey && !c.apiKey) return { ok: false, reason: p.label + ' 需要 API key（用 /perc weather key <key> 设置）' }
      // 全部地点都在失败冷却、且一个旧值都没有 → 如实报不可用。
      // 只要还有一处能报，就不把整块天气标成不可用（家挂了，公司的还要给）。
      const cooldown = Math.max(0, (Number(c.errorCooldownMinutes) || 10) * 60 * 1000)
      const usable = places.some((place) => {
        const slot = slots.get(slotKey(place))
        if (slot && slot.data) return true
        if (slot && slot.lastError.at != null && now() - slot.lastError.at < cooldown) return false
        return true
      })
      if (!usable) {
        const slot = slots.get(slotKey(places[0]))
        const left = Math.max(1, Math.ceil((cooldown - (now() - (slot?.lastError.at || now()))) / 60000))
        return { ok: false, reason: '取数失败：' + (slot?.lastError.msg || '') + '（约 ' + left + ' 分钟后重试）' }
      }
      return { ok: true }
    },

    async perceive() {
      const c = cfg()
      const places = normalizePlaces(c)
      const ttl = Math.max(60 * 1000, (Number(c.ttlMinutes) || 15) * 60 * 1000)
      const cooldown = Math.max(0, (Number(c.errorCooldownMinutes) || 10) * 60 * 1000)
      const lines = []
      const pending = []
      let coldFail = null

      for (const place of places) {
        const key = slotKey(place)
        const slot = slotOf(key)
        const fresh = slot.data && now() - slot.at < ttl
        const cooling = slot.lastError.at != null && now() - slot.lastError.at < cooldown

        if (fresh) {
          const text = renderWeather(slot.data, { label: place.label })
          if (text) lines.push(text)
          continue
        }
        // 过期但有旧值：先用旧的，后台再刷。绝不为了刷新拖慢这一轮。
        if (slot.data) {
          const text = renderWeather(slot.data, { label: place.label })
          if (text) lines.push(text)
          if (!cooling) fetchPlace(place)
          continue
        }
        if (cooling) {
          logger?.warn?.('[perc] weather 处于失败冷却中，跳过（' + (place.label || key) + '）')
          continue
        }
        pending.push(place)
      }

      if (pending.length) {
        const got = await Promise.all(pending.map((place) => fetchPlace(place)))
        pending.forEach((place, i) => {
          const text = got[i] ? renderWeather(got[i], { label: place.label }) : null
          if (text) lines.push(text)
          else if (!coldFail) coldFail = slots.get(slotKey(place))?.lastError.msg || '取数失败'
        })
      }

      if (lines.length) return lines.join('\n')
      // 一个旧值都没有、这次又全失败 → 抛出去，让 /perc 看得见原因。
      // 冷却中的重复失败不抛（上面已经 continue 掉了），免得每轮刷一条 warn。
      if (coldFail) throw new Error(coldFail)
      return null
    }
  }
}
