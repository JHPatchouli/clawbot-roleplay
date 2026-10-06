/**
 * 进程入口：加载配置 → 必要时扫码登录 → 启动 ClawBot 长轮询通道。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from './config/store.js'
import { JsonStore } from './storage/jsonStore.js'
import { createLogger, redact } from './logger.js'
import { acquireLock } from './util/lock.js'
import { createApp } from './app.js'
import { loadCredentials, clearCredentials } from './channel/credentials.js'
import { runLogin } from './channel/login.js'

const DATA_DIR = process.env.DATA_DIR || path.resolve('data')

// 启动期致命错误需要写进 data/server.log：
// 否则「启动即退出」只能靠 docker logs 看到，server.log 里完全无迹可循。
let fatalLogger = null

/**
 * 代码戳：取 src 下所有 .js 的最新 mtime。
 *
 * 为什么需要：node --watch 靠 inotify，跨 bind mount 会**静默失效**——
 * 改了文件也不重启，进程还活着，光看进程存活根本判断不出跑的是哪版代码
 * （P7 部署时就因此误判过一次）。启动日志里带上它就能直接对时间。
 */
function sourceStamp(dir) {
  let latest = 0
  let count = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) {
        count++
        const m = fs.statSync(p).mtimeMs
        if (m > latest) latest = m
      }
    }
  }
  try {
    walk(dir)
  } catch (_) {
    return '未知'
  }
  const t = new Date(latest).toISOString().replace('T', ' ').slice(0, 19)
  return `${count} 个文件，最新改动 ${t}Z`
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const configStore = new ConfigStore(DATA_DIR)
  const config = configStore.get()
  const logger = createLogger(config.logLevel)
  fatalLogger = logger
  const store = new JsonStore(path.join(DATA_DIR, 'store.json'))

  const releaseLock = acquireLock(path.join(DATA_DIR, 'server.lock'), logger)
  logger.info(`ClawBot 服务端启动（dataDir=${DATA_DIR}）`)
  logger.info(`代码戳：${sourceStamp(path.dirname(fileURLToPath(import.meta.url)))}`)
  if (process.env.BUILD_SHA) logger.info(`构建版本：${process.env.BUILD_SHA}`)

  let credentials = loadCredentials(DATA_DIR)
  if (credentials) {
    logger.info(`复用已保存登录凭据（botId=${credentials.botId || '-'}, token=${redact(credentials.token)}）`)
  } else {
    if (process.env.SKIP_LOGIN === '1') {
      logger.error('尚未登录，且 SKIP_LOGIN=1，退出。')
      process.exit(1)
    }
    logger.info('未检测到登录凭据，进入扫码登录流程…')
    credentials = await runLogin({ cfg: config, logger, dataDir: DATA_DIR, store })
  }

  const app = createApp({ dataDir: DATA_DIR, configStore, store, logger, credentials })
  app.channel.onTokenInvalid = () => {
    logger.error('登录凭据失效，已清除本地凭据，请重启容器重新扫码。')
    clearCredentials(DATA_DIR)
    process.exitCode = 2
  }

  const shutdown = async (sig) => {
    logger.info(`收到 ${sig}，正在优雅停止…`)
    await app.channel.stop(sig).catch(() => {})
    releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await app.channel.start()
  if (!app.channel.running) {
    logger.error(`通道未运行（原因：${app.channel.stoppedReason || '未知'}），进程退出。`)
    releaseLock()
    process.exit(2)
  }
}

main().catch((err) => {
  const msg = '[FATAL] ' + (err?.stack || err?.message || String(err))
  console.error(msg)
  try {
    fatalLogger?.error(msg)
  } catch (_) {
    /* 日志写失败不影响退出 */
  }
  process.exit(1)
})
