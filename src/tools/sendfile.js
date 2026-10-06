/**
 * 发文件工具（`send_file`）：让她能把**做好的文件**回传给对方。
 *
 * 为什么单列一个工具，而不是复用委托的返回值：
 *   委托只会把「结论文字」交回来；它做出来的 `报表.csv`、`图表.png` 留在工作目录里。
 *   没有这个工具，她只能说「我做好了」——文件永远送不出去。
 *
 * 允许的范围（**只有这两处**，且只读）：
 *   ① 该用户的**委托工作目录** `<installDir>/work/<用户>/`（她刚做好的产物在这）
 *   ② 她自己的文件沙箱 `<dataDir>/workspace/`（file_write 写出来的东西）
 *   绝对路径也收，但必须落在这两处之内；`..` 越界、符号链接逃逸一律拒——
 *   与 tools/files.js 同一套思路（模型能调的东西必须假定不可信）。
 *
 * 出口两条（顺序固定）：
 *   1. 有本轮 context_token → 直接发（她说完话之前文件先到，像真人先甩文件再说一句）
 *   2. 没有（离线自测/通道不可用）→ 进待发箱，下次收到消息时自动补发
 *
 * 限流：**一轮最多发 maxSendPerTurn 个**（默认 1）。发文件比发文字重得多，
 *   放任她一次甩十个，既淹对方也容易撞微信侧的限流。
 */
import fs from 'node:fs'
import path from 'node:path'
import { enqueue } from '../util/outbox.js'
import { safeKey } from '../agent/delegate.js'

/** 这些扩展名当作图片发（聊天中直接显示，比「一个文件」体验好） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** 路径是否在 root 之内（不含 root 本身） */
export function insideRoot(root, p) {
  const rel = path.relative(root, p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 在若干个允许的根目录里解析用户/模型给的文件路径（纯函数，便于自检）。
 * @param {object} [opts] { allowDir } 打包工具要能接收目录，发文件只能接文件
 * @returns {{abs:string,name:string,bytes:number,root:string}}
 */
export function resolveInRoots(input, roots, { allowDir = false } = {}) {
  const p = String(input || '').trim()
  if (!p) throw new Error('没给文件路径')
  if (/^[a-zA-Z]:[\\/]/.test(p) && process.platform !== 'win32') throw new Error('只接受相对路径或允许范围内的绝对路径')
  const isAbs = path.isAbsolute(p)
  const candidates = []
  if (isAbs) {
    candidates.push(p)
  } else {
    for (const r of roots) candidates.push(path.resolve(r, p))
  }
  const existing = roots.filter((r) => fs.existsSync(r))
  for (const c of candidates) {
    const root = existing.find((r) => insideRoot(r, c))
    if (!root) continue
    if (!fs.existsSync(c)) continue
    // 符号链接收口：解析真实路径后必须仍在允许范围内，否则等于从沙箱里被带出去
    const real = fs.realpathSync(c)
    const rootReal = fs.realpathSync(root)
    if (!insideRoot(rootReal, real)) throw new Error('路径越界（符号链接指向允许范围之外）')
    const st = fs.statSync(real)
    if (!st.isFile() && !(allowDir && st.isDirectory())) {
      throw new Error('不是文件：' + p + '（要发目录先用 zip_files 打包成一个 zip）')
    }
    return { abs: real, name: path.basename(real), bytes: st.size, root, isDir: st.isDirectory() }
  }
  throw new Error('找不到文件：' + p + (existing.length ? '\n可用范围：' + existing.join('、') : '（允许的目录都还不存在）'))
}

/** 按扩展名决定走图片通道还是文件通道 */
export function decideKind(name, want) {
  if (want === 'file' || want === 'image') return want
  return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase()) ? 'image' : 'file'
}

export function createSendTools({ dataDir, config, logger, delegator = null }) {
  const cfg = () => config.tools?.files || {}
  const maxSend = () => Number(config.media?.maxSendBytes ?? 20 * 1024 * 1024)
  const maxPerTurn = () => Math.max(1, Number(cfg().maxSendPerTurn ?? 1))

  /** 该用户能发的东西在哪 */
  const rootsFor = (userId) => {
    const list = []
    const w = delegator && delegator.workDirFor ? delegator.workDirFor(userId) : null
    if (w) list.push(w)
    list.push(path.join(dataDir, 'workspace'))
    return list
  }

  return {
    rootsFor,
    /**
     * @param {object} a { path, as?, name? }
     * @param {object} userCtx { userId, sendFile, sendImage, sent, contextToken }
     * @returns {Promise<string>} 给模型看的结果文本（工具约定：返回字符串）
     */
    async send(a, userCtx = {}) {
      const userId = userCtx.userId
      if (!userId) return '（现在不知道发给谁，没法发文件）'
      const sent = userCtx.sent || (userCtx.sent = { count: 0 })
      if (sent.count >= maxPerTurn()) {
        return `（这一轮已经发过文件了，最多 ${maxPerTurn()} 个。剩下的下次再说）`
      }
      // 解析/读盘失败**不要抛**：抛上去工具层只会加一句「工具 send_file 执行失败」
      // ——对模型毫无用处（它不知道该改什么）。这里给一句它能照着改的话。
      let found
      try {
        found = resolveInRoots(a?.path, rootsFor(userId))
      } catch (e) {
        return '（发不了：' + e.message + '）'
      }
      const limit = maxSend()
      if (found.bytes > limit) {
        return `（文件太大：${found.name} 有 ${Math.round(found.bytes / 1024 / 1024)}MB，超过上限 ${Math.round(limit / 1024 / 1024)}MB）`
      }
      const name = String(a?.name || '').trim() || found.name
      const kind = decideKind(name, a?.as)
      let buf = null
      try {
        buf = fs.readFileSync(found.abs)
      } catch (e) {
        return '（发不了：读不到 ' + found.name + '（' + e.message + '））'
      }
      const sizeText = found.bytes < 1024 ? found.bytes + 'B' : (found.bytes / 1024).toFixed(1) + 'KB'

      // ① 有新鲜 context_token：直接发（她这轮还在回话，token 是刚到的）
      //    ⭐ 失败要**换另一种载体再试一次**：那次图片通道报了
      //    「媒体上传失败 HTTP 500」，于是落进待发箱——对方要等到下次发消息才收到，
      //    而**文件通道明明是通的**（同一个包里 8MB 的 zip 就发出去了）。
      const carriers = kind === 'image' ? ['image', 'file'] : ['file', 'image']
      const failed = []
      for (const c of carriers) {
        const fn = c === 'image' ? userCtx.sendImage : userCtx.sendFile
        if (typeof fn !== 'function') continue
        try {
          // ⚠️ **契约：两条通道都按 `fn(name, buf)` 调**（包装函数在 router.js / followup.js）。
          //    需要避免的问题：图片那条的包装曾写成 `(buf)`，于是这里传的 `name`
          //    被当成图片内容上传（「photo.jpg」→ 10 字节 → AES 补齐 16 字节），CDN 回 500，
          //    实际表现成「图片通道永远发不出去、一直退化成文件」。
          //    自检里断言「传进去的字节数 == 文件字节数」，就是这个坑的护栏。
          await fn(name, buf)
          sent.count += 1
          const how = c === 'image' ? '图片' : '文件'
          logger?.info?.(
            `[send_file] 已发出${how} ${name}（${found.bytes}B，走 ${c} 通道` +
              (failed.length ? `；${failed.join('；')} 先失败了` : '') +
              '）'
          )
          return (
            `已把它当**${how}**发过去了：${name}（${sizeText}）。` +
            (c !== kind ? `（本想当${kind === 'image' ? '图片' : '文件'}发，那条路发不出去，换成了${how}）` : '') +
            `\n（东西已经送出去了。真人在微信里发完图/文件不会去解释「这是什么」，` +
            `**不要向对方解释图片是什么、什么表情**，接着说你要说的话就行；` +
            `文件不要念内容、不要贴代码）`
          )
        } catch (e) {
          failed.push(`${c} 通道：${e.message}`)
          logger?.warn?.(`[send_file] ${c} 通道发送失败：${e.message}`)
        }
      }
      if (failed.length) logger?.warn?.('[send_file] 两种通道都没发出去，改进待发箱：' + failed.join('；'))

      // ② 回落：进待发箱，下次收到消息时补发（与 /export 的「发不出去也不丢」同一条路）
      try {
        enqueue(dataDir, { userId, name, path: found.abs })
        sent.count += 1
        return (
          `已排进待发箱：${name}（${sizeText}）——当前通道发不出去，下一条消息进来时会自动发过去。` +
          `\n（告诉对方「稍后发给你」，不要说成已经发了）`
        )
      } catch (e) {
        return '（发文件失败：' + e.message + '）'
      }
    }
  }
}
