/**
 * 登录凭据持久化（data/credentials.json，权限 0600）。
 * 保存后重启免扫码；凭据含 bot_token。
 */
import fs from 'node:fs'
import path from 'node:path'

export function credentialsPath(dataDir) {
  return path.join(dataDir, 'credentials.json')
}

export function loadCredentials(dataDir) {
  const file = credentialsPath(dataDir)
  try {
    if (!fs.existsSync(file)) return null
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!creds?.token || !creds?.baseUrl) return null
    return creds
  } catch (_) {
    return null
  }
}

export function saveCredentials(dataDir, creds) {
  const file = credentialsPath(dataDir)
  const payload = {
    token: creds.token,
    baseUrl: creds.baseUrl || 'https://ilinkai.weixin.qq.com',
    botId: creds.botId || '',
    userId: creds.userId || '',
    savedAt: new Date().toISOString()
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return payload
}

export function clearCredentials(dataDir) {
  const file = credentialsPath(dataDir)
  try {
    fs.unlinkSync(file)
  } catch (_) {
    /* 不存在则忽略 */
  }
}
