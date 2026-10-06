#!/usr/bin/env node
/**
 * 主动向指定用户发送「配置载体图片」（无需用户先发消息）。
 * 用法：DATA_DIR=/app/data node tools/send-carrier.mjs <userId> [roleplay|settings|providers|all]
 */
import { ConfigStore } from '../src/config/store.js'
import { JsonStore } from '../src/storage/jsonStore.js'
import { ProviderStore } from '../src/providers/store.js'
import { createLogger } from '../src/logger.js'
import { loadCredentials } from '../src/channel/credentials.js'
import { Channel } from '../src/channel/channel.js'
import { makeCarrierPng } from '../src/util/carrier.js'
import { exportSnapshot } from '../src/import/importer.js'

const DATA = process.env.DATA_DIR || '/app/data'
const to = process.argv[2]
const what = (process.argv[3] || 'all').toLowerCase()
if (!to) {
  console.error('用法：node tools/send-carrier.mjs <userId> [roleplay|settings|providers|all]')
  process.exit(1)
}
const configStore = new ConfigStore(DATA)
const store = new JsonStore(DATA + '/store.json')
const logger = createLogger(configStore.get().logLevel || 'info')
const creds = loadCredentials(DATA)
if (!creds) {
  console.error('未找到登录凭据')
  process.exit(1)
}
const providerStore = new ProviderStore(DATA)

let payload
if (what === 'roleplay') payload = exportSnapshot(store)
else if (what === 'settings') payload = { app: 'demo', kind: 'app-settings', version: 1, exportedAt: Date.now(), config: configStore.get() }
else if (what === 'providers') payload = { app: 'demo', kind: 'app-providers', version: 1, exportedAt: Date.now(), providers: providerStore.export({ withSecrets: false }).providers }
else payload = {
  app: 'demo',
  kind: 'app-backup',
  version: 1,
  exportedAt: Date.now(),
  config: configStore.get(),
  providers: providerStore.export({ withSecrets: false }).providers,
  roleplay: exportSnapshot(store).data
}

const text = JSON.stringify(payload, null, 2)
const png = makeCarrierPng(240, 240, text)
const ctxToken = store.get('ctxToken:' + to, '')
const ch = new Channel({ credentials: creds, store, config: configStore.get(), logger })

try {
  await ch.sendImage(to, png, ctxToken)
  console.log('SENT ok bytes=' + png.length + ' payload=' + Buffer.byteLength(text) + ' ctxToken=' + (ctxToken ? 'yes' : 'none'))
} catch (e) {
  console.error('SEND_FAILED ' + e.message)
  process.exitCode = 2
}
