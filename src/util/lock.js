/**
 * 单实例锁：同一 bot_token 不可多进程同时长轮询。
 * 用 data/server.lock 记录持有者 pid，进程退出自动清理。
 *
 * ⚠️ 为何不能只判断「pid 是否存活」：
 *   data/server.lock 位于**数据卷**，会跨容器重建存活；而 pid 只是**当前容器
 *   PID 命名空间**里的编号。新容器里同一个数字很容易被 sshd / bash 之类占用，
 *   于是 `kill(pid, 0)` 成功 → 误判「已有实例在运行」→ 服务拒绝启动。
 *   更坑的是抛错只走到容器 stdout（docker logs），server.log 里什么都看不到，
 *   表现为「容器是 Up 的，但 Bot 静默不工作」。
 *
 * 所以判定存活时额外确认「那个 pid 跑的确实是本项目主进程」
 * （读 /proc/<pid>/cmdline），否则视为陈旧锁直接接管。
 */
import fs from 'node:fs'

const ENTRY_HINT = 'index.js'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

/** 读 /proc/<pid>/cmdline；读不到返回 null（进程不存在，或非 Linux） */
function cmdlineOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch (_) {
    return null
  }
}

/**
 * 该 pid 是否真是「本项目的运行实例」。
 * 拿不到 /proc 时退化为「进程存在即认为被占用」——偏保守，但不会误抢正在跑的实例。
 */
function isOurInstance(pid) {
  const cmd = cmdlineOf(pid)
  if (cmd == null) return isAlive(pid)
  if (/--watch\b/.test(cmd)) return false // node --watch 监督进程本身不算实例
  return cmd.includes('node') && cmd.includes(ENTRY_HINT)
}

export function acquireLock(file, logger = null) {
  if (fs.existsSync(file)) {
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim())
    if (pid && pid !== process.pid) {
      if (isOurInstance(pid)) {
        const msg =
          `检测到另一个实例在运行（pid ${pid}），已拒绝启动。\n` +
          `若确认没有实例在跑，删除 ${file} 后重试。`
        // 必须同时写日志：否则「启动即退出」只能在 docker logs 里看到
        logger?.error(msg)
        const err = new Error(msg)
        err.code = 'LOCK_HELD'
        throw err
      }
      logger?.warn(`发现陈旧单实例锁（pid ${pid} 已不是本项目进程，多为容器重建后 pid 被重用），已接管。`)
    }
  }
  fs.writeFileSync(file, String(process.pid))
  const release = () => {
    try {
      if (String(fs.readFileSync(file, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(file)
    } catch (_) {
      /* 忽略 */
    }
  }
  process.once('exit', release)
  return release
}
