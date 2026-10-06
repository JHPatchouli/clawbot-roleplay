/**
 * 感知管理模块（perception）
 *
 * 定位：把「模型感知不到的客观事实」在**每一轮**喂给它，并且把这件事做成可扩展的架子——
 * 以后加「看视频、开视频链接、TTS、语音转文字」都只是往这里注册一个新的 sense，
 * 不用再动 router / context / prompts 的组装逻辑。
 *
 * 为什么单独成一个模块，而不是塞进 tools：
 *   · 工具是**模型主动去查**（要它想起来、要一次往返、要花 token）；
 *     感知是**每轮自动到达**（时间这种东西，等它想起来问已经是坏体验了）。
 *   · 工具跑在 agent 的循环里，感知要跑在拼提示词之前（时间得先摆进上下文）。
 *   两者共用一套「注册 + 能力清单 + 开关」的写法（参考 tools/），但生命周期不同。
 *
 * 摆位：感知内容**每轮都变**，所以和「相关记忆」一样挂在用户输入之后（尾插），
 * 绝不进 system —— 一旦插在人设后面，后面的历史对话全部失去前缀缓存
 * （见 roleplay/context.js 的注释与 同类框架 的成本数据）。
 *
 * 已注册的能力：
 *   · `time`    —— 当前时刻（时区可配）+ 距上次说话多久（`senses/time.js`）
 *   · `weather` —— 当前天气 + 今日高低温/降水概率（`senses/weather.js`）。
 *     位置必须显式配置；provider 可插拔（默认 Open-Meteo）。
 *
 * 后续能力的现状：
 *   · 容器里**没有 ffmpeg / ffprobe / sox** → 视频抽帧仍未解决
 *   · **语音→文字已单独接入**（`src/asr/`，纯 WASM 解 SILK + 硅基流动识别，见 /asr）
 *   · 语音消息在 normalizeInbound 里已归一化（media/aeskey/duration/text），
 *     且 router 的 `if (!text)` 分支不再静默丢弃只有语音的消息
 *   · 其余（TTS / 看懂视频 / 打开链接）仍登记在 ROADMAP：`/perc` 会如实显示「未接入」，
 *     不假装能做——真正接进来之前不占任何提示词。
 */
import { createTimeSense, DEFAULT_TIME_ZONE } from './senses/time.js'
import { createWeatherSense, normalizePlaces, toCoord } from './senses/weather.js'

/** 已规划、尚未接入的能力（如实展示，别让 /perc 看起来全能） */
export const ROADMAP = [
  {
    id: 'speech',
    name: '语音（语音→文字）',
    // ：语音转文字已经**单独接入**了（它不是「每轮自动到达的事实」，而是入站输入的转换，
    // 所以没放在感知模块里）——这里只留一句指路，免得 /perc 看着像是没做。
    note: '已接入（单独一块，不在这里）：/asr 看状态与开关'
  },
  {
    id: 'tts',
    name: '说话（文字→语音）',
    note: '需要语音合成服务 + 出站语音消息格式（media 上传与加密复用现有 media.js）'
  },
  {
    id: 'video',
    name: '视频（看懂画面）',
    note: '需要抽帧（容器无 ffmpeg）+ 视觉模型；目前入站视频只做留档（/diagvideo）'
  },
  {
    id: 'link',
    name: '链接（打开视频/网页链接）',
    note: '需要抓取与解析；可先复用 tools/web.js 的抓取与 SSRF 防护'
  }
]

const PERCEPTION_TAG = 'perception'

/**
 * @param {object} opts
 * @param {import('../config/store.js').ConfigStore} opts.configStore 每轮实时读配置（`/perc` 改完立即生效）
 * @returns {{register:Function, list:Function, isOn:Function, options:Function, perceive:Function, capabilities:Function}}
 */
export function createPerception({ configStore, config, store, logger } = {}) {
  const senses = new Map()

  const options = () => (configStore?.get?.() || config || {}).perception || {}

  const api = {
    /** 注册一个感知能力；同 id 覆盖（便于运行时替换实现） */
    register(sense) {
      if (sense && sense.id) senses.set(sense.id, sense)
      return api
    },
    list() {
      return [...senses.values()]
    },
    /** 总开关（单能力开关由各 sense 的 enabled() 负责） */
    isOn() {
      return options().enabled !== false
    },
    get(id) {
      return senses.get(id) || null
    },
    /**
     * 收集本轮要注入的感知内容。
     *
     * 任何单个 sense 的失败都只记一条日志并跳过——**感知绝不能把回复搞挂**，
     * 最坏情况是这一轮少了那几行事实，而不是用户收不到回复。
     * @param {object} ctx { userId, sessionId, history, now }
     * @returns {Promise<{text:string|null, blocks:Array, notes:Array}>} text 已带 <perception> 标签
     */
    async perceive(ctx = {}) {
      if (!api.isOn()) return { text: null, blocks: [], notes: ['总开关关闭'] }
      const blocks = []
      const notes = []
      for (const sense of senses.values()) {
        if (typeof sense.enabled === 'function' && !sense.enabled()) {
          notes.push(`${sense.name || sense.id}：已关闭`)
          continue
        }
        const av = typeof sense.available === 'function' ? sense.available() : { ok: true }
        if (!av || av.ok === false) {
          notes.push(`${sense.name || sense.id}：${(av && av.reason) || '不可用'}`)
          continue
        }
        try {
          const text = await sense.perceive(ctx)
          if (text) blocks.push({ id: sense.id, name: sense.name || sense.id, text: String(text) })
        } catch (e) {
          notes.push(`${sense.name || sense.id}：${e.message}`)
          logger?.warn?.('[perc] ' + sense.id + ' 感知失败：' + e.message)
        }
      }
      if (!blocks.length) return { text: null, blocks, notes }
      // 多个感知合并进同一个标签块，避免一次请求里堆好几个 <perception>
      const body = blocks
        .map((b) => (blocks.length === 1 ? b.text : `${b.name}：${b.text}`))
        .join('\n')
      return { text: `<${PERCEPTION_TAG}>\n${body}\n</${PERCEPTION_TAG}>`, blocks, notes }
    },
    /** 给 `/perc` 用：每个能力的开关/可用性 + 未接入清单 */
    capabilities() {
      const enabled = api.isOn()
      const list = api.list().map((s) => {
        const av = typeof s.available === 'function' ? s.available() : { ok: true }
        return {
          id: s.id,
          name: s.name || s.id,
          kind: s.kind || 'input',
          desc: s.desc || '',
          enabled: typeof s.enabled === 'function' ? s.enabled() : true,
          available: !!av?.ok,
          reason: av?.ok === false ? av.reason : ''
        }
      })
      const opts = options()
      const w = opts.weather || {}
      return {
        enabled,
        list,
        roadmap: ROADMAP,
        timeZone: opts.time?.timeZone || DEFAULT_TIME_ZONE,
        noticeHours: opts.time?.gapNoticeHours ?? 6,
        weather: {
          enabled: w.enabled !== false,
          provider: w.provider || 'open-meteo',
          // ⚠️ 用 toCoord 而不是 Number()：默认值是 null，而 Number(null) === 0，
          //    直接把「没配位置」显示成 (0,0)（实际运行中曾经出错）。
          // 单点字段保留，是为了旧的 /perc city 展示；真正注入看 places。
          latitude: toCoord(w.latitude),
          longitude: toCoord(w.longitude),
          label: w.label || '',
          places: normalizePlaces(w),
          ttlMinutes: w.ttlMinutes ?? 15
        }
      }
    }
  }

  api.register(createTimeSense({ configStore, config, store, logger }))
  // 天气：位置必须显式配置。服务器 IP 定位得到的是
  // 部署机房的城市，不是用户的城市）。没配位置时 available() 返回 false，/perc 会如实显示。
  api.register(createWeatherSense({ configStore, config, logger }))
  return api
}
