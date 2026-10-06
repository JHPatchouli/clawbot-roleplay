/**
 * 离线自检：不连接微信，直接把样例消息喂给命令路由，打印回复。
 * 用途：在无法访问 ClawBot（地区/账号限制）时验证命令与消息逻辑。
 *
 *   node src/cli/simulate.js
 *   node src/cli/simulate.js "/help" "/status"
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigStore } from '../config/store.js'
import { JsonStore } from '../storage/jsonStore.js'
import { createLogger } from '../logger.js'
import { createApp } from '../app.js'

const samples = process.argv.slice(2)
const inputs = samples.length
  ? samples
  : ['/help', '/status', '/whoami', '/ping', '你好，你是谁？', '/unknown']

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sim-'))
const configStore = new ConfigStore(dataDir)
const logger = createLogger('warn')
const store = new JsonStore(path.join(dataDir, 'store.json'))

// 无凭据 -> 不创建真实通道；用一个假的 channel 满足 /status 等命令
const app = createApp({ dataDir, configStore, store, logger })
const fakeChannel = { running: false, sendText: async () => {} }

async function run() {
  for (const text of inputs) {
    const replies = []
    const inbound = { userId: 'sim-user', contextToken: 'sim-ctx', text, files: [], items: [] }
    await app.router.handle(inbound, {
      reply: async (t) => replies.push(t),
      channel: fakeChannel,
      store,
      config: app.config,
      logger,
      // 与运行时的 services 对齐：少了这两个，改动型命令（/max、/reply、/key…）
      // 在离线自检里会直接报 undefined，测不到真行为
      configStore: app.configStore,
      providers: app.providers
    })
    console.log(`\n> ${text}`)
    for (const r of replies) console.log(r.replace(/^/gm, '  '))
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
