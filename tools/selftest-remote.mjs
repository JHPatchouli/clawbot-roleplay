#!/usr/bin/env node
/**
 * 在容器里跑一遍自检（对着**当前工作树**，不用先部署、不碰正在跑的服务）。
 *
 * 为什么必须有这一步：
 *   本地是 Windows、容器是 Debian + root，几处差异**只在容器里才暴露**——
 *   ① 主线是 root，委托/发文件那些用例的子进程会**降权成 nobody** →
 *      临时目录权限不对时，这个问题只在容器里出现；
 *   ② 容器里没有 python3（本地有）、没有 zip/unzip；
 *   ③ 容器是 UTC（本地是 UTC+8）→ 时区相关的东西本地测不出来；
 *   ④ 路径分隔符、`path.isAbsolute` 的行为都不同。
 *   所以本地通过后，还需要在容器里再运行一次。
 *
 * 做法：把 src/ 用 tar 推到远端临时目录里跑（`tar -cf - | ssh` 管道由 Node 拉起，
 *   **不经过 PowerShell**，二进制不会被转码），跑完删掉临时目录。
 *
 * 用法（在 server/ 下执行）：
 *   node tools/selftest-remote.mjs                 # 用下面的默认值
 *   node tools/selftest-remote.mjs --keep          # 保留远端目录便于复查
 *   node tools/selftest-remote.mjs --host h --port 2222 --key C:\path\to\key
 *   HOST=... PORT=... KEY=... node tools/selftest-remote.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)

const HOST = arg('host', process.env.HOST || '')
const PORT = arg('port', process.env.PORT || '2222')
const KEY = arg('key', process.env.KEY || path.join(os.homedir(), '.ssh', 'id_ed25519'))
const REMOTE_DIR = arg('dir', process.env.REMOTE_DIR || '/tmp/st-tree')
const TIMEOUT_MS = Number(arg('timeout', process.env.TIMEOUT || 10 * 60 * 1000))
const KEEP = flag('keep')

// 本项目不内置默认主机：必须显式给出目标机器，避免把部署环境写进仓库
if (!HOST) {
  console.error('缺少目标主机。用法：node tools/selftest-remote.mjs --host <主机名> [--port 22] [--key <密钥路径>]')
  process.exit(1)
}

const LOG = path.join(SERVER_DIR, '..', '.tmp', 'selftest-remote.log')

const sshBase = ['-o', 'StrictHostKeyChecking=accept-new', '-p', String(PORT), '-i', KEY, `root@${HOST}`]

function run(cmd, args, { stdin = null, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    p.stdout.on('data', (d) => (out = Buffer.concat([out, d])))
    p.stderr.on('data', (d) => (err = Buffer.concat([err, d])))
    const t = setTimeout(() => {
      try {
        p.kill('SIGKILL')
      } catch (_) {}
      resolve({ code: -1, out: out.toString('utf8'), err: err.toString('utf8') + '\n（超时杀掉了）' })
    }, timeout)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out: out.toString('utf8'), err: err.toString('utf8') })
    })
    if (stdin) stdin(p.stdin)
  })
}

/** 把本地 src/ 打成 tar 流，直接喂给 ssh 的 stdin（Node 管道 = 原始字节） */
function pipeTarToSsh(remoteCmd, { timeout }) {
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-cf', '-', '-C', SERVER_DIR, 'src'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ssh = spawn('ssh', [...sshBase, remoteCmd], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let tarErr = ''
    tar.stdout.pipe(ssh.stdin)
    tar.stderr.on('data', (d) => (tarErr += d.toString('utf8')))
    ssh.stdout.on('data', (d) => (out = Buffer.concat([out, d])))
    ssh.stderr.on('data', (d) => (err = Buffer.concat([err, d])))
    const t = setTimeout(() => {
      for (const p of [tar, ssh]) {
        try {
          p.kill('SIGKILL')
        } catch (_) {}
      }
      resolve({ code: -1, out: out.toString('utf8'), err: err.toString('utf8') + '\n（超时杀掉了）' })
    }, timeout)
    ssh.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out: out.toString('utf8'), err: (tarErr + err.toString('utf8')).trim() })
    })
  })
}

const t0 = Date.now()
console.log(`[远端自检] ${HOST}:${PORT} → ${REMOTE_DIR}（key=${KEY}）`)
console.log(`[远端自检] 打包本地工作树：${path.join(SERVER_DIR, 'src')}`)

const remote =
  `set -e; rm -rf ${REMOTE_DIR}; mkdir -p ${REMOTE_DIR}; tar -xf - -C ${REMOTE_DIR}; ` +
  `cd ${REMOTE_DIR}; ` +
  // 先报环境，再跑：日志要能自证「这是在哪个环境跑出来的」
  `echo "== 容器环境 =="; node -v; uname -sr; id -u; echo "TZ=$(date +%Z) uid=$(id -u)"; ` +
  `node -e "console.log('platform=' + process.platform + ' 谁在跑=' + (process.getuid && process.getuid()))"; ` +
  `echo "== 自检 =="; node src/cli/selftest.js; echo "__EXIT__$?"`

const res = await pipeTarToSsh(remote, { timeout: TIMEOUT_MS })
const text = res.out || ''
const clean = text.replace(/__EXIT__(\d+)/, (_, n) => `退出码=${n}`)
const failed = clean.split('\n').filter((l) => l.includes('\u2718'))
const withEnv = clean.match(/__EXIT__(\d+)/)
const code = withEnv ? Number(withEnv[1]) : res.code

try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.writeFileSync(LOG, clean + '\n', 'utf8')
} catch (_) {}

// 终端只打关键几行（全文已落盘，本地看 CJK 输出容易乱码）
const lines = clean.split('\n')
const tail = lines.slice(-14).join('\n')
console.log('\n' + tail)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log('  ' + f.trim())
}
if (!withEnv && res.err) console.log('\n[stderr] ' + res.err.slice(0, 400))
console.log(`\n全文日志：${LOG}`)
console.log(`[远端自检] ${code === 0 ? '✅ 通过' : '❌ 失败'}（exit=${code}，用时 ${Math.round((Date.now() - t0) / 1000)}s）`)

if (!KEEP) {
  await run('ssh', [...sshBase, `rm -rf ${REMOTE_DIR}`], { timeout: 30000 })
}
process.exit(code === 0 ? 0 : 1)
