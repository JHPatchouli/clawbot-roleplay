/**
 * 委托 runner：被主进程以**降权身份**（默认 nobody）spawn 出来的子进程，
 * 在这里面把任务交给成熟的 agent 框架（Claude Agent SDK）去干。
 *
 * 协议：
 *   stdin  ← 一行 JSON：{ task, files, model, cwd, maxTurns, timeoutMs, systemAppend,
 *                         allowedTools, disallowedTools, sdkEntry, denyPrivate }
 *   env    ← DELEGATE_KEY（模型的 Key，只走环境变量，不写进任何文件、不打日志）
 *   stdout → 人类可读的进度（故意简短）+ 最后一行 `@@RESULT@@{...json...}`
 *
 * 为什么单独开一个进程、而不是在主进程里直接调 SDK：
 *   ① 主进程是 root，而 SDK 会**自己起一个 CLI 子进程**去跑 Bash——
 *      只有把「起 SDK 的这一步」就放在降权进程里，Bash 才真的不是 root；
 *   ② SDK 可能崩、可能卡住，放在独立进程里可以被硬超时 SIGKILL，不牵连微信通道；
 *   ③ 它的 env 是清洗过的，主进程的密钥不会顺带漏过去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeHooks } from './hooks.js'

const RESULT_MARK = '@@RESULT@@'

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => {
      buf += d
      if (buf.length > 1024 * 1024) reject(new Error('入参过大'))
    })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

/** 收集本次委托留下的文件（给回执用；只在 workDir 里数，最多 20 个） */
function listWorkFiles(dir) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 2 || out.length >= 20) return
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const e of entries) {
      if (out.length >= 20) return
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else {
        try {
          const st = fs.statSync(p)
          out.push({ path: path.relative(dir, p), bytes: st.size })
        } catch (_) {
          /* 忽略 */
        }
      }
    }
  }
  walk(dir, 0)
  return out
}

const fail = (reason) => {
  process.stdout.write('\n' + RESULT_MARK + JSON.stringify({ ok: false, error: String(reason).slice(0, 400) }) + '\n')
  process.exit(0)
}

/**
 * 统一收尾出口。
 *
 * ⚠️ 为什么失败也要走这里：实际运行中出现过——跑到 maxTurns 上限时，框架**抛错**结束，
 *   原来的 catch 只回一句「运行失败」，把已经收集到的工具调用、产物、部分结论全部丢掉了。
 *   调用方只看到「它什么都没做」，而实际上它可能已经下载了文件、写了报表。
 *   失败路径也要保留已经收集到的诊断信息。
 */
const emit = (payload) => {
  process.stdout.write('\n' + RESULT_MARK + JSON.stringify(payload) + '\n')
  process.exit(0)
}

async function main() {
  const raw = await readStdin()
  let req = null
  try {
    req = JSON.parse(raw || '{}')
  } catch (e) {
    return fail('入参不是 JSON：' + e.message)
  }
  const key = process.env.DELEGATE_KEY || ''
  if (!key) return fail('缺少 DELEGATE_KEY')
  const sdkEntry = String(req.sdkEntry || '')
  if (!sdkEntry || !fs.existsSync(sdkEntry)) return fail('agent 框架没装好：' + (sdkEntry || '(未配置路径)'))

  const cwd = String(req.cwd || process.cwd())
  fs.mkdirSync(cwd, { recursive: true })

  let query = null
  try {
    ;({ query } = await import(sdkEntry))
  } catch (e) {
    return fail('加载 SDK 失败：' + e.message)
  }

  // 指向「Anthropic 兼容」的第三方端点（DeepSeek /anthropic 可用）。
  // 几个 *MODEL* 变量都要给：运行时会用较小模型处理标题和摘要，
  // 不覆盖就会去请求 anthropic.com 的 haiku，在第三方端点上必然 404。
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || cwd,
    TMPDIR: process.env.TMPDIR || path.join(cwd, '.tmp'),
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'Asia/Shanghai',
    ANTHROPIC_BASE_URL: String(req.baseUrl || ''),
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: String(req.model || ''),
    ANTHROPIC_SMALL_FAST_MODEL: String(req.model || ''),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: String(req.model || ''),
    ANTHROPIC_DEFAULT_SONNET_MODEL: String(req.model || ''),
    ANTHROPIC_DEFAULT_OPUS_MODEL: String(req.model || ''),
    // 隐私/噪声：关闭非必要的外部上报
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    // 以 root 跑时框架会拒绝 bypassPermissions，除非声明自己在沙箱里。
    // 我们其实是降权到 nobody + data 目录 700，比它想要的沙箱更实在。
    IS_SANDBOX: '1'
  }
  fs.mkdirSync(env.TMPDIR, { recursive: true })

  const timeoutMs = Math.max(5000, Number(req.timeoutMs) || 180000)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  const started = Date.now()
  const toolCalls = []
  const texts = []
  let result = null
  let sawInit = null
  let sessionId = String(req.resume || '') || ''

  /** 收尾：把**当前已经拿到的东西**都交回去（成功与失败走同一条） */
  const finish = (extra) =>
    emit({
      subtype: 'success',
      isError: false,
      text: '',
      turns: null,
      costUsd: null,
      usage: null,
      init: sawInit,
      sessionId,
      toolCalls,
      files: listWorkFiles(cwd),
      ...extra
    })

  try {
    const q = query({
      prompt: String(req.task || ''),
      options: {
        model: String(req.model || ''),
        cwd,
        permissionMode: 'bypassPermissions',
        // 续跑：上一轮跑到上限时，用同一个会话接着干（而不是从零重来）
        ...(req.resume ? { resume: String(req.resume) } : {}),
        // 只留「干活」需要的；Task/Skill/Cron/Worktree 之类一律去掉：
        // 它们要么会再起一层子 agent（成本翻倍），要么与我们的场景无关。
        allowedTools: req.allowedTools,
        disallowedTools: req.disallowedTools,
        maxTurns: Math.max(1, Number(req.maxTurns) || 12),
        env,
        abortController: ac,
        // 不读用户的 ~/.claude 配置与 cwd 上层的 CLAUDE.md：
        // 委托必须是**可复现**的，别被容器里遗留的文件改变行为
        settingSources: [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: String(req.systemAppend || '')
        },
        hooks: makeHooks(),
        stderr: (s) => {
          const t = String(s).trim()
          if (!t) return
          // 框架的 stderr 可能有噪声，但不打就没法排障；截断并**不落盘**
          process.stderr.write('[cli] ' + t.slice(0, 300) + '\n')
        }
      }
    })

    for await (const m of q) {
      if (m.session_id) sessionId = m.session_id
      if (m.type === 'system' && m.subtype === 'init') {
        sawInit = { model: m.model, tools: m.tools, cwd: m.cwd, sessionId: m.session_id }
        process.stdout.write('init model=' + m.model + ' tools=' + (m.tools || []).length + '\n')
      }
      if (m.type === 'assistant') {
        for (const b of (m.message && m.message.content) || []) {
          if (b.type === 'text' && String(b.text || '').trim()) texts.push(String(b.text).trim())
          if (b.type === 'tool_use' && toolCalls.length < 40) {
            toolCalls.push({ name: b.name, input: JSON.stringify(b.input || {}).slice(0, 300) })
            process.stdout.write('tool ' + b.name + ' ' + JSON.stringify(b.input || {}).slice(0, 160) + '\n')
          }
        }
      }
      if (m.type === 'result') result = m
    }
    clearTimeout(timer)
  } catch (e) {
    clearTimeout(timer)
    const aborted = ac.signal.aborted
    // 撞到 maxTurns 时框架是**抛错**结束的，而它抛的那句话里带着真实轮数
    // （"Reached maximum number of turns (8)"）——不解析出来，日志里只能显示「往返=?」，
    // 实际运行中就曾经出错了：明明跑了 8 轮，看起来像「一轮都没跑」。
    const hitMax = /maximum number of turns \((\d+)\)/i.exec(String((e && e.message) || ''))
    // 把已经拿到的工具调用 / 部分结论 / 产物一起交回去（见 emit 的注释）
    return finish({
      ok: false,
      subtype: 'error',
      isError: true,
      error: aborted ? `超时（${Math.round(timeoutMs / 1000)} 秒）已中止` : '运行失败：' + (e && e.message),
      text: texts.join('\n'),
      turns: hitMax ? Number(hitMax[1]) : null,
      ms: Date.now() - started
    })
  }

  if (!result) {
    return finish({
      ok: false,
      subtype: 'error',
      isError: true,
      error: '没有拿到结果（框架没有返回 result）',
      text: texts.join('\n'),
      ms: Date.now() - started
    })
  }

  const text = String(result.result || texts.join('\n') || '').trim()
  finish({
    ok: result.subtype === 'success' && !result.is_error,
    subtype: result.subtype || '',
    isError: !!result.is_error,
    text,
    turns: result.num_turns ?? null,
    ms: result.duration_ms ?? Date.now() - started,
    // ⚠️ cost_usd 是按 **Anthropic 价目表**估的，我们跑在 DeepSeek 上，这个数**不能信**；
    // 实际用量看 usage（input/output tokens）
    costUsd: result.total_cost_usd ?? null,
    usage: result.usage || null,
    error: result.subtype === 'success' && !result.is_error ? null : result.subtype || 'error'
  })
}

main().catch((e) => fail('runner 异常：' + (e && e.stack ? e.stack.split('\n')[0] : e)))
