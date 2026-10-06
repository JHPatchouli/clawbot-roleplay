/**
 * 扫码登录页（可选，绑 127.0.0.1，配合 SSH 隧道访问）。
 * 无头容器里扫码的两条路径：
 *   1) 容器日志里的 ASCII 二维码（默认，见 login.js）
 *   2) 本登录页：展示二维码 + 需要时提交数字配对码
 * 只用 Node 原生 http，零依赖。
 */
import http from 'node:http'

function pageHtml(state) {
  const img = state.qrImageUrl
    ? `<img src="${state.qrImageUrl}" alt="QR" width="280" height="280"/>`
    : '<p>二维码生成中…</p>'
  const verifyBlock =
    state.status === 'need_verifycode'
      ? `<form method="POST" action="/verify">
           <input name="code" placeholder="请输入手机微信显示的数字配对码" autocomplete="off"/>
           <button type="submit">提交</button>
         </form>`
      : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ClawBot 登录</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:40px auto;padding:0 16px}
img{border:1px solid #eee;border-radius:12px}h1{font-size:18px}.s{color:#666}code{word-break:break-all;font-size:12px}</style>
</head><body>
<h1>ClawBot 扫码登录</h1>
<p class="s">状态：<b id="st">${state.status}</b> ${state.message || ''}</p>
${img}
${verifyBlock}
<p class="s">用手机微信扫码并按提示确认。二维码内容：</p>
<code>${state.qrcodeContent || '-'}</code>
<script>
setInterval(async () => {
  try {
    const r = await fetch('/status.json'); const j = await r.json();
    if (j.status !== document.getElementById('st').textContent) location.reload();
  } catch (e) {}
}, 2000);
</script>
</body></html>`
}

export function createLoginPage({ host = '127.0.0.1', port = 8080, logger } = {}) {
  let state = { status: 'starting', message: '', qrcodeContent: null, qrImageUrl: null }
  let verifyResolver = null

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(pageHtml(state))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/status.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ status: state.status, message: state.message }))
      return
    }
    if (req.method === 'POST' && req.url.startsWith('/verify')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') || ''
        if (verifyResolver) {
          verifyResolver(code.trim())
          verifyResolver = null
        }
        res.writeHead(302, { Location: '/' })
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          logger?.info(`登录页已启动：http://${host}:${port} （建议通过 SSH 隧道访问）`)
          resolve()
        })
      })
    },
    setState(patch) {
      state = { ...state, ...patch }
    },
    /** 等待登录页提交的数字配对码 */
    waitForVerifyCode() {
      return new Promise((resolve) => {
        verifyResolver = resolve
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
