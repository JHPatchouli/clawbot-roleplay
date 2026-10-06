/**
 * 原地写入部署：保留 inode，让 node --watch 能收到事件并热重载。
 *
 *   node tools/apply-files.mjs <payloadDir> <destDir> [--entry src/index.js]
 *
 * 为什么需要它：
 *   `tar -xzf` / `scp` / `git pull` 都是用 **rename 换新 inode** 的方式落盘，
 *   而 node --watch 的 inotify 监听挂在旧 inode 上 —— 换完之后监听**静默失效**，
 *   再 `touch` 也不会有反应，只能重启容器（P7 部署时反复曾经出错）。
 *   fs.writeFileSync 到已存在的路径是「截断 + 写回同一个 inode」，
 *   因此会触发 MODIFY 事件，监听照常工作。
 *
 * 输出会区分「改写」与「新增」：新增的模块文件需要重启才能被加载，
 * 这点不哄人 —— 不然后面又在猜「为什么改了没生效」。
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const entryIdx = args.indexOf('--entry')
const entryRel = entryIdx >= 0 ? args[entryIdx + 1] : 'src/index.js'
// 注意：entryIdx 为 -1（没传 --entry）时不能按索引过滤，否则会把第一个位置参数也删掉
const positional = entryIdx >= 0 ? args.filter((a, i) => a !== '--entry' && i !== entryIdx + 1) : args
const [src, dest] = positional

if (!src || !dest) {
  console.error('用法：node tools/apply-files.mjs <payloadDir> <destDir> [--entry src/index.js]')
  process.exit(1)
}
if (!fs.existsSync(src)) {
  console.error('找不到来源目录：' + src)
  process.exit(1)
}

const stats = { changed: 0, created: 0, same: 0, dirs: 0 }

function walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, e.name)
    const relPath = rel ? path.join(rel, e.name) : e.name
    const to = path.join(dest, relPath)
    if (e.isDirectory()) {
      if (!fs.existsSync(to)) {
        fs.mkdirSync(to, { recursive: true })
        stats.dirs++
      }
      walk(from, relPath)
      continue
    }
    const buf = fs.readFileSync(from)
    const existed = fs.existsSync(to)
    if (existed) {
      const old = fs.readFileSync(to)
      if (old.length === buf.length && Buffer.compare(old, buf) === 0) {
        stats.same++
        continue
      }
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    // 关键：写入「已存在的路径」→ 复用 inode → inotify 发 MODIFY 而不是 DELETE/CREATE
    fs.writeFileSync(to, buf)
    existed ? stats.changed++ : stats.created++
  }
}

walk(src)

// 兜底：把入口文件的 mtime 推一下，确保 watcher 一定收到一次事件
try {
  const entry = path.join(dest, entryRel)
  if (fs.existsSync(entry)) {
    const now = new Date()
    fs.utimesSync(entry, now, now)
  }
} catch (_) {
  /* 忽略 */
}

console.log(
  `apply-files：改写 ${stats.changed} · 新增 ${stats.created} · 未变 ${stats.same}` +
    (stats.dirs ? ` · 新建目录 ${stats.dirs}` : '')
)
if (stats.created) {
  console.log(`注意：有 ${stats.created} 个**新增**文件，node --watch 不会加载新模块，需要重启容器。`)
}
if (!stats.changed && !stats.created) {
  console.log('没有文件变化。')
} else if (stats.changed) {
  // 诚实的提示：原地写入只是「不会弄坏监听」，救不活已经坏掉的监听
  console.log(
    '提示：已原地写入（保留 inode），node --watch 通常会捕捉到变化。\n' +
      '      若 5 秒后日志里没有新的「服务端启动」，说明监听早已失效\n' +
      '      （多为此前用 tar 直接解包到仓库、或 git pull 换过 inode）——\n' +
      '      此时在宿主机执行 docker restart clawbot 即可。'
  )
}
