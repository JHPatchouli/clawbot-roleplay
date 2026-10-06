/**
 * 委托器：把「需要动手做」的任务交给一个**成熟的 agent 框架**去干（默认 Claude Agent SDK）。
 *
 * 设计立场：我们的框架不自己重造一套代码执行沙箱，
 *   而是当「导演」——模型自己判断这件事该不该外包，然后委托出去、拿回结果、用自己的口吻说出来。
 *   理由：成熟框架已经带了「写文件 → 跑命令 → 看报错 → 改 → 再跑」的完整循环与工具集，
 *   自己实现一遍必然更弱（我们只有 web_fetch/file_*，做不了多步）。
 *
 * 隔离（三条，缺一不可）：
 *   ① **降权**：主线是 root，但委托走独立 runner 子进程并以 nobody 启动，
 *      连它起的 Bash 也是 nobody → 读不到 `data/`（那里钉着 700 + 微信凭据 + 各家 Key）。
 *   ② **清洗 env**：只传 PATH/HOME/TZ 等必要变量 + 模型 Key；主线进程的 env 不继承。
 *   ③ **命令闸门**：hooks.js 拦内网地址与提权类 Bash 命令（内网元数据是最现实的凭据外泄口）。
 *
 * 已知残余风险（要如实告诉用户）：
 *   · 模型 Key 必须进子进程 env（框架要用它调 API），脚本理论上可以 echo 它 →
 *     建议给委托单独开一把 Key / 控制余额，别用主 Key。
 *   · 闸门是启发式的，绕得过去（比如把 IP 拼起来）。真正的边界是 ①。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskSecrets } from '../logger.js'

const RESULT_MARK = '@@RESULT@@'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 只有这些工具留给它：干活够用，且都看得见（Task/Skill/Cron/Worktree 一律不给） */
export const DEFAULT_ALLOWED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch']

/** 明确禁掉的：多起一层子 agent（成本翻倍）、与容器调度相关、与我们的场景无关 */
export const DEFAULT_DISALLOWED = [
  'Task',
  'Skill',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'ListAgents',
  'SendMessage',
  'ReportFindings',
  'Workflow',
  'NotebookEdit',
  'TaskOutput',
  'TaskStop',
  'WebSearch' // 走 Anthropic 的检索服务，在第三方兼容端点上必然失败；要查资料用 WebFetch
]

/** 委托时追加给框架的说明：无人在场，必须自主做完，且要**知道自己的能力边界** */
const SYSTEM_APPEND =
  '你是在替一个微信聊天机器人干活，**没有人会在旁边回答你**：' +
  '不要提问、不要请求确认、不要留下待办，自己判断并一路做完。\n' +
  '你有：命令行（curl/node/python 之类能用就用）、文件读写、抓取指定网址（WebFetch）。\n' +
  '⚠️ 你**没有搜索引擎**：搜不到东西。要么手上有具体网址，要么只能盲试——' +
  '盲试两次还拿不到就直接如实说「拿不到，需要对方提供链接或关键词」，' +
  '**不要反复换关键词空转**（那只会把往返次数花光，最后什么都交不出来）。\n' +
  '往返次数有限（系统会给上限）：感觉快用完了就先停手，把手上的结果整理出来交回去，' +
  '哪怕只是「找到一半」也比什么都没交强。\n' +
  '最后用一段简短的中文说清「你做了什么 + 结论是什么」，不要贴大段代码/日志（除非对方要求）。' +
  '产物放到当前工作目录下。'

const MAX_STDERR_LINES = 12

/**
 * 这些失败值得**续跑**（接着同一个会话干）——它们都不是真错误，只是「预算用尽」：
 *   · 撞到往返上限（框架抛 "Reached maximum number of turns"）
 *   · 一轮跑超时被中止（硬超时到了，但会话还在、活干了一半）
 * 反过来，缺 Key / 框架没装 / 会话丢失这类续跑没意义 → 不白花钱。
 * ⚠️ 「超时」这条是 实际运行补上的：那次第一轮跑到 180s 被硬停，
 *    它已经下了 20 个产物（5 张图）却**没人接着干**，等于白扔了那一轮。
 */
const RESUMABLE_ERROR = /maximum number of turns|\bturns?\b|超时|aborted|timed?\s?out/i

/** 给续跑提示语用的人话：这一轮为什么没跑完（认不出来就返回空串） */
function failKind(parsed) {
  const reason = String(parsed?.error || '')
  if (/maximum number of turns|\bturns?\b/i.test(reason)) return '往返次数用光'
  if (/超时|aborted|timed?\s?out/i.test(reason)) return '等它太久（超时）'
  return ''
}

function safeKey(s) {
  // 用户 id 里有 `@` `_` `-` 等，做目录名要收敛；同时别让路径逃出去
  return String(s || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'anon'
}

/** 导出给「发文件」工具用：它要知道委托产物落在哪个目录 */
export { safeKey }

export function createDelegator({ dataDir, config, logger, providerStore }) {
  const cfg = () => config.agent || {}
  const installDir = () => cfg().installDir || path.resolve(dataDir, '..', 'data-agent')
  const sdkEntry = () =>
    cfg().sdkEntry || path.join(installDir(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
  const runnerPath = () => cfg().runner || path.join(HERE, 'runner.mjs')
  const workRoot = () => cfg().workDir || path.join(installDir(), 'work')
  const homeRoot = () => path.join(installDir(), 'home')
  const maxTurns = () => Math.max(1, Number(cfg().maxTurns) || 12)
  const maxResumes = () => Math.max(0, Number(cfg().maxResumes ?? 1))
  const timeoutMs = () => Math.max(1000, Number(cfg().timeoutMs) || 180000)
  // runner 自己的超时到点后会 abort 并正常退出（还能把 result 交回来），
  // 所以要再给一段余量才动 SIGKILL。这段时间是「优雅收尾」用的，不是随便加的。
  const killSlackMs = () => Math.max(100, Number(cfg().killSlackMs ?? 15000))
  const maxResultChars = () => Math.max(200, Number(cfg().maxResultChars) || 1500)
  const model = () => cfg().model || 'deepseek-chat'
  const baseUrl = () => cfg().baseUrl || 'https://api.deepseek.com/anthropic'
  /** 用哪家的 Key：默认取 providerStore 里那家（与对话同源，用户不用再配一遍） */
  const keyFor = () => {
    if (cfg().apiKey) return String(cfg().apiKey)
    const id = cfg().provider || 'deepseek'
    const p = providerStore && providerStore.get ? providerStore.get(id) : null
    return (p && p.apiKey) || ''
  }
  const canDropPrivileges = () => typeof process.getuid === 'function' && process.getuid() === 0

  let running = null
  let last = null
  /**
   * 干完活之后的回调（由 app.js 注入）。
   *
   * 为什么要有它：委托一跑就是几分钟，而任务在聊天流程中执行——
   * 把这一轮钉住几分钟，对方就只能盯着「正在输入」发呆。改成后台跑：
   * 她先回一句「我去弄一下」，干完由回调把结果交回给她，她再自然地说给对方。
   */
  let onDone = null
  /** 后台队列：排队等着跑的活（同一时刻只跑一件，见 pump） */
  const queue = []
  let pumping = false
  const maxQueue = () => Math.max(1, Number(cfg().maxQueue ?? 3))

  /**
   * 队列泵：同一时刻只跑一件。
   *
   * 为什么串行：框架自己就要起 CLI 子进程、吃内存（单个任务可能占用数百 MB 内存），
   * 并发跑两个容易把容器拖死；账单也难控。排队比拒绝体验好，但也不能无限排。
   */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length) {
        const job = queue.shift()
        let res
        try {
          res = await api.execute(job.task, job.ctx)
        } catch (e) {
          // 委托层的异常绝不能把泵弄死（否则后面排队的活永远不跑了）
          res = { ok: false, text: '（委托异常：' + ((e && e.message) || e) + '）', meta: null }
          logger?.warn?.('[delegate] 后台委托异常：' + (e && e.stack ? e.stack.split('\n')[0] : e))
        }
        try {
          await onDone?.({ ...job, ...res })
        } catch (e2) {
          logger?.warn?.('[delegate] 委托结果回传失败：' + ((e2 && e2.message) || e2))
        }
      }
    } finally {
      pumping = false
    }
  }

  const api = {
    /** 能不能用：装好了没 / 有没有 Key。工具注册与 /agent 展示都看它 */
    available() {
      if (cfg().enabled === false) return { ok: false, reason: '已关闭（/agent on）' }
      if (!fs.existsSync(runnerPath())) return { ok: false, reason: 'runner 缺失：' + runnerPath() }
      if (!fs.existsSync(sdkEntry())) {
        return { ok: false, reason: 'agent 框架未安装（安装目录：' + installDir() + '）' }
      }
      if (!keyFor()) return { ok: false, reason: '缺少模型 Key（/key set）' }
      return { ok: true }
    },

    info() {
      const av = api.available()
      // Key 从哪来：专用 Key 优先，否则回落对话 Provider 的。只打码展示，不暴露原值
      const own = String(cfg().apiKey || '')
      const pid = cfg().provider || 'deepseek'
      const used = own || (keyFor() ? 'fallback' : '')
      return {
        ...av,
        installDir: installDir(),
        workDir: workRoot(),
        model: model(),
        baseUrl: baseUrl(),
        maxTurns: maxTurns(),
        timeoutMs: timeoutMs(),
        dropping: canDropPrivileges(),
        busy: !!running || pumping,
        queue: queue.length,
        maxQueue: maxQueue(),
        maxResumes: maxResumes(),
        keySource: own
          ? `专用 Key（${own.slice(0, 7)}…${own.slice(-4)}）`
          : used
            ? `回落到对话 Provider「${pid}」的 Key（建议配专用 Key：/agent key <密钥>）`
            : '（无）',
        last
      }
    },

    /** 某个用户的委托工作目录（发文件工具要在这里找产物） */
    workDirFor(userId) {
      return path.join(workRoot(), safeKey(userId))
    },

    /**
     * 最坏情况要花多久（含续跑与优雅收尾的余量）。
     *
     * 调用方（delegate_task 工具）拿它去**申请延长本轮消息处理的时限**。
     * 不申请会怎样：通道给的时限比委托预算短，
     * 于是委托**必然**被判「消息处理超时」，表现为一句报错，
     * 而活还在后台跑、跑完的结果没处可去。
     * 算法：每轮硬超时 × (1+续跑次数) + 每轮收尾余量 + 5s 余量。
     */
    budgetMs() {
      return timeoutMs() * (1 + maxResumes()) + killSlackMs() + 5000
    },

    /** 最近一次委托（给 /agent log 用，不落盘） */
    last: () => last,

    /** 注入「干完之后的回调」（app.js 用它把结果交回给角色，让她自己转达对方） */
    setCallback(fn) {
      onDone = typeof fn === 'function' ? fn : null
    },

    /**
     * 后台跑一件活：**立刻**回执，干完再回调（不阻塞任何一轮回复）。
     *
     * 这是模型那条路的默认姿势（`delegate_task` 工具就是调它）：
     * 她说完「我去弄一下」就能正常回对方，几分钟后结果到了再由回调处理。
     *
     * @returns {{ok:boolean, text:string, ahead?:number}} text 是给模型的回执（它会照着说人话）
     */
    enqueue(task, ctx = {}) {
      const t = String(task || '').trim()
      if (!t) return { ok: false, text: '（委托内容为空）' }
      const av = api.available()
      if (!av.ok) return { ok: false, text: '（委托不可用：' + av.reason + '）' }
      if (queue.length >= maxQueue()) {
        return {
          ok: false,
          text: `（手上还排着 ${queue.length} 件没做完，这阵子先别接新的；可以说“手上还有活，等一下再说”）`
        }
      }
      queue.push({ task: t, ctx, at: Date.now() })
      const ahead = queue.length - 1 + (pumping ? 1 : 0)
      void pump()
      logger?.info?.(`[delegate] 已排入后台队列（前面还有 ${ahead} 件，任务 ${t.length} 字）`)
      return {
        ok: true,
        ahead,
        text:
          '（已经交给它**在后台**去做了，你**不用等**：先跟对方说一句「我去弄一下，弄好了发你」这类的话就行。' +
          '它做完会**自动把结果送到你手上**（到时会有一条系统提示），到时你再用一两句话把结果转达对方。' +
          '它一般要花几十秒到几分钟。' +
          (ahead ? `它前面还有 ${ahead} 件在做，会按顺序来。` : '') +
          '）'
      }
    },

    /** 阻塞式委托一次（`/agent run` 用：当场等结果，方便你验证链路）。失败都返回 {ok:false, text} */
    async run(task, ctx = {}) {
      const t = String(task || '').trim()
      if (!t) return { ok: false, text: '（委托内容为空）' }
      if (running || pumping) return { ok: false, text: '（上一次委托还在跑，等它结束）' }
      return api.execute(t, ctx)
    },

    /**
     * 真正跑一次委托（阻塞到它结束）。任何失败都返回 {ok:false, text} ——**绝不让委托把回复搞挂**。
     * ⚠️ 别直接给模型用：这条会阻塞整轮（后台跑请用 enqueue）。
     * @param {string} task 任务描述（模型写的，要自带全部上下文）
     * @param {object} ctx { userId, sessionId, characterId }
     */
    async execute(task, ctx = {}) {
      const t = String(task || '').trim()
      if (!t) return { ok: false, text: '（委托内容为空）' }
      const av = api.available()
      if (!av.ok) return { ok: false, text: '（委托不可用：' + av.reason + '）' }

      const userKey = safeKey(ctx.userId)
      const cwd = path.join(workRoot(), userKey)
      const home = path.join(homeRoot(), userKey)
      const uid = canDropPrivileges() ? Number(cfg().uid ?? 65534) : null
      const gid = canDropPrivileges() ? Number(cfg().gid ?? 65534) : null

      try {
        fs.mkdirSync(cwd, { recursive: true })
        fs.mkdirSync(home, { recursive: true })
        // 降权后要能写自己的工作目录；data/ 在容器里是 700（root），nobody 摸不到
        if (uid != null) {
          for (const d of [cwd, home, workRoot(), homeRoot()]) {
            try {
              fs.chownSync(d, uid, gid)
            } catch (_) {
              /* 非关键 */
            }
          }
        }
      } catch (e) {
        return { ok: false, text: '（准备工作目录失败：' + e.message + '）' }
      }

      const payload = {
        task: t,
        model: model(),
        baseUrl: baseUrl(),
        cwd,
        maxTurns: maxTurns(),
        timeoutMs: timeoutMs(),
        sdkEntry: sdkEntry(),
        allowedTools: Array.isArray(cfg().allowedTools) && cfg().allowedTools.length ? cfg().allowedTools : DEFAULT_ALLOWED,
        disallowedTools: DEFAULT_DISALLOWED,
        systemAppend: cfg().systemAppend || SYSTEM_APPEND
      }

      const env = {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: home,
        TMPDIR: path.join(cwd, '.tmp'),
        LANG: 'C.UTF-8',
        TZ: 'Asia/Shanghai',
        DELEGATE_KEY: keyFor()
      }

      // 清洗 env：主线进程的部署变量一律不继承，只留白名单 + 模型 Key
      const childEnv = { ...process.env, ...env }
      for (const k of Object.keys(childEnv)) {
        if (!(k in env) && k !== 'NODE_OPTIONS' && k !== 'SystemRoot' && k !== 'windir' && k !== 'TEMP' && k !== 'TMP') {
          delete childEnv[k]
        }
      }

      const started = Date.now()
      logger?.info?.(
        `[delegate] 开始委托（user=${userKey} model=${model()} 最多 ${maxTurns()} 轮/可续跑 ${maxResumes()} 次 任务 ${t.length} 字）：` +
          maskSecrets(t).slice(0, 80)
      )
      let out = ''
      let err = ''

      /**
       * 跑一轮 runner（跑完就返回，失败不抛）。
       * @param {object} opt { resume: sessionId|null, task, timeoutMs, note }
       */
      const runOnce = async ({ resume, task: taskText, timeoutMs: passMs, note }) => {
        const child = spawn(process.execPath, [runnerPath()], {
          cwd,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(uid != null ? { uid, gid } : {})
        })
        running = { startedAt: Date.now(), userId: ctx.userId }
        let o = ''
        let e = ''
        child.stdout.on('data', (d) => {
          o += d
          if (o.length > 512 * 1024) o = o.slice(-256 * 1024)
        })
        child.stderr.on('data', (d) => {
          e += d
          if (e.length > 256 * 1024) e = e.slice(-64 * 1024)
        })
        // ⚠️ 任务是通过 **stdin** 传给 runner 的（不走命令行参数：长任务带换行/引号会出事）。
        // 漏了这一步的话 runner 会一直等输入，直到硬超时——自检第一次跑就是这么挂住的。
        child.stdin.on('error', () => {
          /* runner 提前退出时的 EPIPE，不影响结论 */
        })
        try {
          child.stdin.end(
            JSON.stringify({
              ...payload,
              task: taskText,
              ...(resume ? { resume } : {}),
              ...(note ? { systemAppend: payload.systemAppend + '\n（这是**接着上一轮**继续：' + note + '）' } : {})
            })
          )
        } catch (e2) {
          logger?.warn?.('[delegate] 任务写入失败：' + e2.message)
        }

        const hardMs = passMs + killSlackMs()
        let killed = false
        const killer = setTimeout(() => {
          killed = true
          try {
            child.kill('SIGKILL')
          } catch (_) {}
        }, hardMs)

        const done = await new Promise((resolve) => {
          child.on('error', (e2) => resolve({ code: -1, spawnError: e2.message }))
          child.on('close', (code, signal) => resolve({ code, signal }))
        })
        clearTimeout(killer)
        running = null

        let parsed = null
        const idx = o.lastIndexOf(RESULT_MARK)
        if (idx >= 0) {
          const line = o.slice(idx + RESULT_MARK.length).split('\n')[0]
          try {
            parsed = JSON.parse(line)
          } catch (_) {
            parsed = null
          }
        }
        return {
          parsed,
          killed,
          done,
          ms: Date.now() - started,
          errTail: e
            .split('\n')
            .filter((l) => l.trim())
            .slice(-MAX_STDERR_LINES)
            .join('\n')
        }
      }

      // 续跑：跑到 maxTurns 上限时**接着同一个会话继续**（而不是从零重来）。
      // 实际运行中的毛病：一个「找图」任务在第 8 轮被硬停，8 轮里做的事**全被丢掉**，
      // 用户只看到「找人帮忙了但没找到」。提高上限只能延后问题（任务更难就再撞），
      // 真正管用的是「允许接着干」+「无论如何把已经做的交回来」。
      const passes = []
      let resumes = 0
      const budgetEnd = started + timeoutMs() * (1 + maxResumes())
      for (let attempt = 0; attempt <= maxResumes(); attempt++) {
        const remain = budgetEnd - Date.now()
        // ⚠️ 这个阈值别写成固定 8000：小超时配置（比如自检里的 1s）下会导致**一轮都没跑**，
        //    而失败文案又会谎称「runner 异常退出」——自检抓到过。
        //    只要求「剩下的时间够跑一整轮（上限不超过 8 秒）」即可。
        if (remain < Math.max(1000, Math.min(8000, timeoutMs()))) break
        const prev = passes[passes.length - 1]
        const why = prev && !prev.parsed?.ok ? failKind(prev.parsed) : ''
        const pass = await runOnce({
          resume: attempt === 0 ? null : prev?.parsed?.sessionId || null,
          task: t,
          timeoutMs: Math.min(timeoutMs(), remain),
          note:
            attempt === 0
              ? ''
              : `上一轮${why ? '因为' + why + ' ' : ''}没跑完${prev?.killed ? '（被硬停了）' : ''}。` +
                '这次**先把已经拿到的结果整理交回来**，再接着做剩下的；不要从头再来一遍。'
        })
        passes.push(pass)
        if (pass.parsed?.ok) break
        const reason = String(pass.parsed?.error || '')
        // 只有「**预算用尽**（撞往返上限 / 跑超时）+ 拿得到会话 id」才值得续跑——
        // 这两类都不是真错误，只是没干完，接着干是最省的（不必从零重来）。
        // 缺 Key / 框架没装 / 会话丢失这类续跑没意义，没有 sessionId 也只能从零重来（那不如不花这钱）。
        if (!RESUMABLE_ERROR.test(reason)) break
        if (!pass.parsed?.sessionId) break
        if (attempt < maxResumes()) resumes = attempt + 1
      }

      const final = passes[passes.length - 1] || null
      const parsed = final?.parsed || null
      out = ''
      err = passes.map((p) => p.errTail).filter(Boolean).join('\n')
      const ms = Date.now() - started
      // 多轮的工具调用与产物要**合并**（否则续跑那轮会把前一轮的成果盖掉）
      const toolCalls = []
      const files = []
      for (const p of passes) {
        for (const c of p.parsed?.toolCalls || []) toolCalls.push(c)
        for (const f of p.parsed?.files || []) if (!files.some((x) => x.path === f.path)) files.push(f)
      }
      const turnsTotal = passes.reduce((a, p) => a + (Number(p.parsed?.turns) || 0), 0)
      const usage = parsed?.usage || null

      if (!parsed && !toolCalls.length && !files.length) {
        const why = final?.killed
          ? `超过 ${Math.round((timeoutMs() + killSlackMs()) / 1000)} 秒仍未结束，已强制结束`
          : final
            ? `runner 异常退出（code=${final.done?.code}${final.done?.signal ? ' signal=' + final.done.signal : ''}${final.done?.spawnError ? ' ' + final.done.spawnError : ''}）`
            : '时间预算不够，一次都没跑'
        last = { at: started, task: t, ok: false, ms, error: why, stderr: err.slice(0, 800) }
        logger?.warn?.('[delegate] 委托失败：' + why + (err ? '\n' + err : ''))
        return { ok: false, text: `（委托失败：${why}）` }
      }

      const ok = !!parsed?.ok
      const kb = (n) => (n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB')
      const fileList = files
        .slice(0, 5)
        .map((f) => f.path + '（' + kb(f.bytes) + '）')
        .join('、')

      let text = String(parsed?.text || '').trim()
      if (!ok) {
        // 没做完也要把「已经做了什么」交回来——这是模型唯一能挽救这轮的信息
        const parts = []
        parts.push(`（它没做完：${parsed?.error || '未给出结论'}${turnsTotal ? `，一共跑了 ${turnsTotal} 轮` : ''}）`)
        if (toolCalls.length) parts.push(`它已经动手做了 ${toolCalls.length} 步：` + toolCalls.slice(-4).map((c) => c.name).join('、'))
        if (files.length) parts.push(`留在工作目录里的产物：${fileList}`)
        if (text) parts.push('它最后说的话：' + text)
        if (!text && !toolCalls.length && !files.length) parts.push('它没有留下任何结果')
        text = parts.join('\n')
      }
      const clipped = text.length > maxResultChars()
      if (clipped) text = text.slice(0, maxResultChars()) + '…（内容过长已截断）'

      last = {
        at: started,
        task: t,
        ok,
        ms,
        turns: turnsTotal || null,
        resumes,
        sessionId: parsed?.sessionId || null,
        toolCalls,
        files,
        usage,
        text,
        error: ok ? null : parsed?.error || parsed?.subtype || '未知',
        stderr: err.slice(0, 800)
      }
      logger?.info?.(
        `[delegate] 委托${ok ? '完成' : '未完成'}：${Math.round(ms / 1000)}s 往返=${turnsTotal || '?'}` +
          (resumes ? `（含续跑 ${resumes} 次）` : '') +
          ` 工具=${toolCalls.length} 次 产物=${files.length} 个 回复 ${text.length} 字` +
          (ok ? '' : ' 原因=' + (parsed?.error || parsed?.subtype))
      )
      if (!ok && err) logger?.warn?.('[delegate] stderr 末尾：\n' + err)

      return { ok, text: text || '（它没有给出结论）', meta: last }
    }
  }

  return api
}
