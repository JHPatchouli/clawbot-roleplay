/**
 * 轻量日志：带时间戳与级别，零依赖。
 * - 始终输出到 console（容器 / docker logs 可见）
 * - 若设置了 DATA_DIR（或 LOG_FILE），同时追加写入文件，便于远程排查
 * redact() 用于日志中处理 token / key。
 */
import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const logFile = process.env.LOG_FILE || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'server.log') : null)
let stream = null
if (logFile) {
  try {
    stream = fs.createWriteStream(logFile, { flags: 'a' })
  } catch (_) {
    stream = null
  }
}

function fmtArg(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try {
    return JSON.stringify(a)
  } catch (_) {
    return String(a)
  }
}

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info
  const write = (lv, args) => {
    if ((LEVELS[lv] ?? 20) < threshold) return
    const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `[${t}] ${lv.toUpperCase().padEnd(5)} ${args.map(fmtArg).join(' ')}`
    const sink = lv === 'error' ? console.error : lv === 'warn' ? console.warn : console.log
    sink(line)
    if (stream) {
      try {
        stream.write(line + '\n')
      } catch (_) {
        /* 忽略写文件失败 */
      }
    }
  }
  return {
    level,
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a)
  }
}

/** 保留少量头尾，其余打码 */
export function redact(value, keep = 6) {
  if (typeof value !== 'string' || !value) return value
  if (value.length <= keep * 2) return '***'
  return `${value.slice(0, keep)}…${value.slice(-4)}`
}

/** 形似密钥的片段：sk-/pk-/api-key/token_/secret- 等前缀 + 一段有长度的字符 */
const KEY_SHAPE = /\b(?:sk|pk|api[-_]?key|token|secret)[-_][A-Za-z0-9_.-]{8,}/gi
/** 够长且只含密钥类字符的串（仅在消息本身提到「密钥/key/token」时才启用，避免误伤正常长文本） */
const LONG_SECRET = /\b[A-Za-z0-9_-]{28,}\b/g
/** 消息里出现密钥类词汇 */
const SECRET_WORD = /密钥|key|token|secret|apikey/i
/**
 * 配置密钥类命令：命中即整条不记。
 * 为什么不能只看形状：密钥前缀五花八门（sk-/tvly-/BSA…/纯十六进制），
 * 命中这些命令时后面跟的一定是密钥，所以不猜形状，直接整条丢掉。
 * 注意 /key list、/provider 这类不带密钥的命令不在此列，仍照常记录。
 */
const SET_KEY_CMD = /^\s*\/\s*(?:key\s+set|set\s+key|tools\s+web\s+(?:key|token)|agent\s+key|perc\s+weather\s+key)\b/i

/**
 * 把文本里形似密钥的片段打码（用于任何要进日志的自由文本）。
 * 注意：不依赖命令名，而是按「密钥长什么样」判断——
 * 因为命令写法会变（`/key set` 曾经漏掉了 `/set key`），形状不会变。
 */
export function maskSecrets(text) {
  let t = String(text ?? '')
  t = t.replace(KEY_SHAPE, (m) => m.slice(0, 3) + '***')
  if (SECRET_WORD.test(t)) t = t.replace(LONG_SECRET, (m) => m.slice(0, 3) + '***')
  return t
}

/**
 * 入站消息文本 → 可安全写日志的形式。
 *
 * 处理顺序：
 *   1. 粘贴的 JSON         → 只记长度，不记内容
 *   2. 配置类命令           → 整条替换为 [已省略]（命令后跟的一定是密钥，连服务商名也不记）
 *   3. 其余文本按密钥形状打码 → 与命令写法无关，写法怎么变都不会漏
 *   4. 最后                → 截断到 limit 字（保持 JSON.stringify 的引号形式）
 */
export function safeInboundText(text, limit = 120) {
  const raw = String(text ?? '')
  if (/^\s*[[{]/.test(raw)) return `[JSON ${raw.length} 字，内容已省略]`
  if (SET_KEY_CMD.test(raw)) return '[已省略]'
  return JSON.stringify(maskSecrets(raw).slice(0, limit))
}
