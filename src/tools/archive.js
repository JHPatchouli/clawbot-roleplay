/**
 * 打包 / 解包工具（`zip_files` / `unzip_file`）。
 *
 * 为什么需要「压缩」这一环：
 *   委托做完的东西经常是**好几个文件**（数据 csv + 图表 png + 说明 md），
 *   一个一个发既难看又容易撞微信侧限流（我们一轮只让发 1 个）。
 *   打包成一个 .zip 才是「能交付」的形态。
 *
 * 与 send_file 共用同一套「允许范围」：该用户的委托工作目录 + 她的文件沙箱。
 * 产物也落在工作目录里，所以打完包直接 `send_file 结果.zip` 就能发出去。
 *
 * ⚠️ 解包是**不可信输入**：zip-slip（`../` 逃逸）、绝对路径、条目数与解压体积上限
 *   在 zip.js 里拦一道，这里写盘前再校验一次「最终路径必须落在目标目录内」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildZip, readZip, isSafeEntryName } from './zip.js'
import { resolveInRoots, insideRoot } from './sendfile.js'

/** 把「一行/逗号分隔」的路径串拆成数组 */
export function splitPaths(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean)
  return String(input || '')
    .split(/[\n,;，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 输出名收敛成一个安全的文件名（保留中文，去掉路径分隔符与点开头） */
export function safeFileName(name, fallback = '打包.zip') {
  let n = String(name || '').trim() || fallback
  n = n.replace(/[\\/]/g, '_').replace(/^\.+/, '').replace(/[\0<>:"|?*]/g, '_')
  if (!n) n = fallback
  if (!/\.zip$/i.test(n)) n += '.zip'
  return n.slice(0, 80)
}

/** 递归收集文件（供打包目录用）。⚠️ 目录里的**符号链接一律跳过**：
 *  否则沙箱里放一个指向外面的软链，打包就能把外面读出去（statSync 会跟随链接）。 */
export function collectFiles(abs, { maxEntries = 500, maxBytes = 64 * 1024 * 1024 } = {}) {
  const out = []
  let bytes = 0
  const walk = (p) => {
    const lst = fs.lstatSync(p)
    if (lst.isSymbolicLink()) return
    if (lst.isFile()) {
      bytes += lst.size
      if (bytes > maxBytes) throw new Error(`内容太大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB），先挑一部分打包`)
      out.push({ abs: p, bytes: lst.size, mtime: lst.mtimeMs })
      return
    }
    if (!lst.isDirectory()) return
    for (const name of fs.readdirSync(p).sort()) {
      if (out.length >= maxEntries) throw new Error(`文件太多（超过 ${maxEntries} 个），先挑一部分打包`)
      walk(path.join(p, name))
    }
  }
  walk(abs)
  return out
}

export function createArchiveTools({ dataDir, config, logger, delegator = null }) {
  const cfg = () => config.tools?.files || {}
  const maxEntries = () => Math.max(1, Number(cfg().maxZipEntries ?? 500))
  const maxBytes = () => Math.max(1024, Number(cfg().maxZipBytes ?? 64 * 1024 * 1024))
  const maxUnzip = () => Math.max(1024, Number(cfg().maxUnzipBytes ?? 64 * 1024 * 1024))
  const sendLimit = () => Number(config.media?.maxSendBytes ?? 20 * 1024 * 1024)

  /** 她手边的东西在哪（与 send_file 完全一致：委托工作目录 + 文件沙箱） */
  const rootsFor = (userId) => {
    const list = []
    const w = delegator && delegator.workDirFor ? delegator.workDirFor(userId) : null
    if (w) list.push(w)
    list.push(path.join(dataDir, 'workspace'))
    // 用 realpath 的形式参与路径比较：resolveInRoots 返回的是 realpath，
    // 两边不同源时 insideRoot 会误判成「不在范围内」（/app 这类挂载点容易踩）
    return list.map((p) => {
      try {
        return fs.realpathSync(p)
      } catch (_) {
        return p
      }
    })
  }
  /** 产物写到委托工作目录；没有委托器就写文件沙箱 */
  const outDirFor = (userId) => {
    const w = delegator && delegator.workDirFor ? delegator.workDirFor(userId) : null
    const dir = w || path.join(dataDir, 'workspace')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  return {
    rootsFor,
    /** 打包：多个文件/目录 → 一个 .zip（落在工作目录里） */
    async zip(a, userCtx = {}) {
      const userId = userCtx.userId
      if (!userId) return '（现在不知道是谁的东西，没法打包）'
      const wanted = splitPaths(a?.paths ?? a?.path)
      if (!wanted.length) return '（没说打包什么：把要打包的文件名给我，多个用换行或逗号分开）'

      let totalRaw = 0
      const picked = []
      try {
        for (const w of wanted) {
          const found = resolveInRoots(w, rootsFor(userId), { allowDir: true })
          const st = fs.statSync(found.abs)
          if (st.isDirectory()) {
            for (const f of collectFiles(found.abs, { maxEntries: maxEntries(), maxBytes: maxBytes() })) {
              picked.push(f)
              totalRaw += f.bytes
              if (picked.length > maxEntries()) throw new Error(`文件太多（超过 ${maxEntries()} 个），先挑一部分打包`)
            }
          } else {
            picked.push({ abs: found.abs, bytes: found.bytes, mtime: st.mtimeMs })
            totalRaw += found.bytes
          }
        }
      } catch (e) {
        return '（打不了包：' + e.message + '）'
      }
      if (!picked.length) return '（那些东西里没有可打包的文件）'

      // 归档内的名字：统一用「相对允许根目录的路径」，这样不会撞名、也保留了目录结构
      const entries = []
      for (const f of picked) {
        const root = rootsFor(userId).find((r) => insideRoot(r, f.abs)) || path.dirname(f.abs)
        const name = path.relative(root, f.abs) || path.basename(f.abs)
        let data = null
        try {
          data = fs.readFileSync(f.abs)
        } catch (e) {
          return '（打不了包：读不到 ' + name + '（' + e.message + '））'
        }
        entries.push({ name, data, mtime: f.mtime })
      }

      let built = null
      try {
        built = buildZip(entries, { maxEntries: maxEntries(), maxTotalBytes: maxBytes() })
      } catch (e) {
        return '（打不了包：' + e.message + '）'
      }

      const zipName = safeFileName(a?.name, path.basename(picked[0].abs).replace(/\.[^.]+$/, '') + '.zip')
      const out = path.join(outDirFor(userId), zipName)
      try {
        fs.writeFileSync(out, built.buffer)
        // 跟随目录属主：委托产物目录是 nobody 的，产物也应当是它（否则两边混着 root 文件）
        try {
          const st = fs.statSync(path.dirname(out))
          fs.chownSync(out, st.uid, st.gid)
        } catch (_) {
          /* 非 root 或跨平台时忽略 */
        }
      } catch (e) {
        return '（打包写盘失败：' + e.message + '）'
      }

      const kb = (n) => (n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB')
      logger?.info?.(`[zip] ${zipName}：${built.entries} 个文件 ${kb(built.rawBytes)} → ${kb(built.buffer.length)}`)
      const tooBig = built.buffer.length > sendLimit()
      return (
        `打包好了：${zipName}（${built.entries} 个文件，${kb(built.rawBytes)} → ${kb(built.buffer.length)}）` +
        (tooBig
          ? `\n⚠️ 超过发送上限（${Math.round(sendLimit() / 1024 / 1024)}MB），发不出去，得先挑小一点的内容`
          : `\n（要发给对方就 send_file ${zipName}）`) +
        `\n里面是：` + entries.slice(0, 8).map((e) => e.name).join('、') + (entries.length > 8 ? ' 等' : '')
      )
    },

    /** 解包：把 .zip 解到工作目录的子目录里 */
    async unzip(a, userCtx = {}) {
      const userId = userCtx.userId
      if (!userId) return '（现在不知道是谁的东西，没法解包）'
      let found = null
      try {
        found = resolveInRoots(a?.path, rootsFor(userId), { allowDir: true })
      } catch (e) {
        return '（解不了：' + e.message + '）'
      }
      if (found.isDir) return '（解不了：' + found.name + ' 是个目录，不是压缩包）'
      let buf = null
      try {
        buf = fs.readFileSync(found.abs)
      } catch (e) {
        return '（解不了：读不到 ' + found.name + '（' + e.message + '））'
      }
      let parsed = null
      try {
        parsed = readZip(buf, { maxEntries: maxEntries(), maxTotalBytes: maxUnzip() })
      } catch (e) {
        return '（解不了：' + e.message + '）'
      }
      if (!parsed.entries.length) return '（这个压缩包是空的）'

      const base = path.join(outDirFor(userId), safeFileName(a?.out || found.name.replace(/\.zip$/i, ''), '解包').replace(/\.zip$/i, ''))
      const written = []
      let bytes = 0
      for (const e of parsed.entries) {
        const target = path.join(base, e.name)
        // 第二道闸门：写盘前再确认最终路径确实落在目标目录里（zip.js 已拦过一遍，这里不省）
        if (!insideRoot(base, target)) return '（解不了：压缩包里有越界路径 ' + e.name + '）'
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, e.data)
        } catch (err) {
          return '（解不了：写 ' + e.name + ' 失败（' + err.message + '））'
        }
        written.push(e.name)
        bytes += e.size
      }
      // 属主跟随工作目录：主进程是 root，写出来的文件默认归 root，
      // 而工作目录（以及被委托的那个 agent）是 nobody 的——不 chown 的话
      // 「她自己写的」与「委托做出来的」两批文件属主不一致，nobody 覆写会失败。
      // zip 那侧早就这么做了，这里保持一致。
      try {
        const owner = fs.statSync(path.dirname(base))
        fs.chownSync(base, owner.uid, owner.gid)
        for (const rel of written) {
          const parts = String(rel).split('/')
          let acc = base
          for (const seg of parts) {
            acc = path.join(acc, seg)
            fs.chownSync(acc, owner.uid, owner.gid)
          }
        }
      } catch (_) {
        /* 非 root 或跨平台时忽略 */
      }
      const kb = (n) => (n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB')
      logger?.info?.(`[unzip] ${found.name} → ${path.relative(outDirFor(userId), base)}（${written.length} 个文件）`)
      return (
        `解开了：${found.name}（${written.length} 个文件，${kb(bytes)}）→ ${path.basename(base)}/` +
        `\n里面是：` + written.slice(0, 8).join('、') + (written.length > 8 ? ' 等' : '') +
        `\n（要看看里面某个文件就用 file_read，路径写 ${path.basename(base)}/文件名）`
      )
    },

    /** 供 send_file 提示用：把「目录」这个常见误用说清楚 */
    looksLikeDir: (p, userId) => {
      try {
        return fs.statSync(resolveInRoots(p, rootsFor(userId)).abs).isDirectory()
      } catch (_) {
        return false
      }
    },
    // 导出给自检
    _internals: { isSafeEntryName }
  }
}
