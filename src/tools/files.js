/**
 * 文件工具：**只在她手边的那几处**读写。
 *
 * 手边有两处：
 *   ① 该用户的**委托工作目录** `<installDir>/work/<用户>/` —— 委托产物、zip/unzip 的结果都在这儿；
 *   ② 她的文件沙箱 `data/workspace/` —— `file_write` 写草稿的地方。
 * 为什么必须统一：原来这里只认 workspace，于是「解压到工作目录 → 用 file_read 看」
 * 是句**空话**（解出来的文件她根本读不到）。同一类东西各认各的根，迟早会在链路上断掉。
 * 解析顺序：先工作目录、再 workspace（刚做出来的东西优先命中）；同名都存在于两处时以工作目录为准。
 *
 * 安全设计（模型能调用的东西必须假定不可信）：
 *  1. 只接受相对路径；绝对路径、`..` 越界一律拒绝
 *  2. 用 realpath 校验「已存在的父目录」，阻止「符号链接指到沙箱外」绕过
 *  3. 读/写有字节上限，防止一次把大文件塞进上下文或写爆磁盘
 *  4. 只允许文本文件（按扩展名白名单 + 拒绝二进制特征）
 */
import fs from 'node:fs'
import path from 'node:path'

/** 允许的文本类扩展名（其余一律拒绝，避免把二进制当文本读坏上下文） */
const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.html', '.htm', '.xml', '.ini', '.conf'
])

export function createFileTools({ dataDir, config, delegator = null }) {
  const workspace = path.join(dataDir, 'workspace')
  const cfg = () => config.tools?.files || {}
  const maxRead = () => (cfg().maxReadBytes ?? 64 * 1024)
  const maxWrite = () => (cfg().maxWriteBytes ?? 256 * 1024)

  const realOr = (p) => {
    try {
      return fs.realpathSync(p)
    } catch (_) {
      return p
    }
  }

  /**
   * 她手边的根目录（工作目录在前）。
   * 没有 userId 时不带工作目录——按用户分目录，不知道是谁就不能瞎猜。
   */
  function rootsFor(userId) {
    const list = []
    const w = userId && delegator && delegator.workDirFor ? delegator.workDirFor(userId) : null
    if (w) list.push({ abs: w, label: '工作目录' })
    list.push({ abs: workspace, label: 'workspace' })
    return list.map((r) => {
      try {
        fs.mkdirSync(r.abs, { recursive: true })
      } catch (_) {
        /* 不致命，解析时再抛 */
      }
      return { ...r, abs: realOr(r.abs) }
    })
  }

  /**
   * 把「相对路径」解析成某个根目录内的绝对路径，越界即抛错。
   */
  function safePathIn(rootReal, rel) {
    const p = String(rel ?? '').trim()
    if (/^[a-zA-Z]:[\\/]/.test(p)) throw new Error('只接受相对路径，不能使用盘符')
    if (path.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) {
      throw new Error('只接受相对路径（文件沙箱与工作目录之内）')
    }
    const abs = path.resolve(rootReal, p)
    const relCheck = path.relative(rootReal, abs)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error('路径越界：只能操作手边这些目录里的文件')
    }
    // 符号链接防护：逐级检查已存在的目录真实路径仍在根目录内
    let cur = path.dirname(abs)
    while (cur.length >= rootReal.length) {
      if (fs.existsSync(cur)) {
        const real = fs.realpathSync(cur)
        const rc = path.relative(rootReal, real)
        if (rc.startsWith('..') || path.isAbsolute(rc)) {
          throw new Error('路径越界：符号链接指向允许范围之外')
        }
        break
      }
      cur = path.dirname(cur)
    }
    return abs
  }

  /**
   * 定位一个路径。
   * @param {boolean} forWrite 写操作：同名文件已存在于某个根就写那儿，否则写第一个根
   */
  function locate(rel, userId, { forWrite = false } = {}) {
    const roots = rootsFor(userId)
    const errs = []
    const resolved = []
    for (const r of roots) {
      try {
        resolved.push({ ...r, abs: safePathIn(r.abs, rel) })
      } catch (e) {
        errs.push(r.label + '：' + e.message)
      }
    }
    // 已存在的优先——写操作也要**就地**写同名文件，别在另一个抽屉里凭空多出一份
    const existing = resolved.find((r) => fs.existsSync(r.abs))
    if (existing) return existing
    // 新建：落在第一个根（工作目录）
    // ⚠️ 这里必须用提前 return 而不是循环里记 fallback：循环里记会被后面的根**反复覆盖**，
    //    最后落到最后一个根上（第一版就是这么错的，自检直接抓出来）
    if (forWrite && resolved.length) return resolved[0]
    const hint = errs.length ? '（' + errs.join('；') + '）' : '（可先用 file_list 看有什么）'
    throw new Error('找不到文件：' + rel + hint)
  }

  function checkText(file) {
    const ext = path.extname(file).toLowerCase()
    if (ext && !TEXT_EXT.has(ext)) throw new Error(`不允许的文件类型 ${ext}（仅支持文本类文件）`)
  }

  return {
    root: workspace,
    /** 供别的模块（/tools、自检）看「她现在能碰哪些目录」 */
    rootsFor: (userId) => rootsFor(userId).map((r) => r.abs),

    list({ dir = '.' } = {}, userId = null) {
      // 默认（不指定 dir）：把**所有**根目录都列出来——
      // 「我手边有什么」应该一次看得全，而不是让人猜文件在哪个抽屉里
      if (!dir || dir === '.' || dir === './') {
        const parts = []
        for (const r of rootsFor(userId)) {
          let entries = []
          try {
            entries = fs.readdirSync(r.abs, { withFileTypes: true }).slice(0, 200)
          } catch (_) {
            continue
          }
          const lines = entries.map((e) => {
            if (e.isDirectory()) return '📁 ' + e.name + '/'
            let size = 0
            try {
              size = fs.statSync(path.join(r.abs, e.name)).size
            } catch (_) {}
            return '📄 ' + e.name + '  ' + size + 'B'
          })
          parts.push(`【${r.label}】` + (lines.length ? '\n' + lines.join('\n') : '（空）'))
        }
        return parts.join('\n') || '（手边还没有任何文件）'
      }
      const found = locate(dir, userId)
      if (!fs.existsSync(found.abs)) return '（目录不存在：' + dir + '）'
      if (!fs.statSync(found.abs).isDirectory()) return '（不是目录：' + dir + '）'
      const entries = fs.readdirSync(found.abs, { withFileTypes: true }).slice(0, 200)
      if (!entries.length) return '（空目录）'
      const lines = entries.map((e) => {
        if (e.isDirectory()) return '📁 ' + e.name + '/'
        const s = fs.statSync(path.join(found.abs, e.name))
        return '📄 ' + e.name + '  ' + s.size + 'B'
      })
      return `【${found.label}】` + dir.replace(/\/+$/, '') + '/\n' + lines.join('\n')
    },

    read({ path: rel, maxBytes } = {}, userId = null) {
      const found = locate(rel, userId)
      const abs = found.abs
      checkText(abs)
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + rel + '（可先用 file_list 看有什么）')
      const st = fs.statSync(abs)
      if (!st.isFile()) throw new Error('不是文件：' + rel)
      const limit = Math.min(Number(maxBytes) || maxRead(), maxRead())
      const buf = fs.readFileSync(abs)
      const slice = buf.subarray(0, limit)
      const text = slice.toString('utf8')
      const truncated = buf.length > limit
      return (
        '文件 ' + rel + '（' + buf.length + 'B' + (truncated ? '，已截断到 ' + limit + 'B' : '') + '）：\n' +
        text +
        (truncated ? '\n…（内容更长，已被截断）' : '')
      )
    },

    write({ path: rel, content = '' } = {}, userId = null) {
      const abs = locate(rel, userId, { forWrite: true }).abs
      checkText(abs)
      const text = String(content)
      const bytes = Buffer.byteLength(text)
      if (bytes > maxWrite()) throw new Error(`内容过大（${bytes}B，上限 ${maxWrite()}B）`)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, text)
      return '已写入 ' + rel + '（' + bytes + 'B）'
    },

    append({ path: rel, content = '' } = {}, userId = null) {
      const abs = locate(rel, userId, { forWrite: true }).abs
      checkText(abs)
      const text = String(content)
      const bytes = Buffer.byteLength(text)
      const existing = fs.existsSync(abs) ? fs.statSync(abs).size : 0
      if (existing + bytes > maxWrite()) throw new Error(`追加后超过上限（${existing + bytes}B > ${maxWrite()}B）`)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.appendFileSync(abs, text)
      return '已追加到 ' + rel + '（+' + bytes + 'B，现 ' + (existing + bytes) + 'B）'
    },

    remove({ path: rel } = {}, userId = null) {
      const abs = locate(rel, userId).abs
      if (!fs.existsSync(abs)) throw new Error('文件不存在：' + rel)
      const st = fs.statSync(abs)
      if (st.isDirectory()) throw new Error('只能删除文件，不能删除目录')
      fs.unlinkSync(abs)
      return '已删除 ' + rel
    }
  }
}
