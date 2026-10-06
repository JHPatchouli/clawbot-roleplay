/**
 * 扫码登录流程（生成二维码 → 长轮询状态 → 保存凭据）。
 *
 * 状态：wait / scaned / confirmed / expired / need_verifycode /
 *       verify_code_blocked / scaned_but_redirect / binded_redirect
 *
 * 设计：登录是「随时可扫」的——二维码过期会自动重新生成，
 * 主循环永不放弃，避免无头容器里一旦没及时扫码就彻底卡死。
 *
 * 二维码展示：容器日志 ASCII（默认）+ 可选登录页。
 */
import readline from 'node:readline'
import qrcode from 'qrcode-terminal'
import { apiRequest, LOGIN_BASE_URL } from './http.js'
import { makeQrImageUrl } from './qrImage.js'
import { createLoginPage } from './loginPage.js'
import { saveCredentials, loadCredentials } from './credentials.js'

const MAX_QR_REFRESH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchQrCode(cfg, localTokens) {
  return apiRequest(LOGIN_BASE_URL, '/ilink/bot/get_bot_qrcode', {
    method: 'POST',
    query: { bot_type: 3 },
    body: { local_token_list: Array.isArray(localTokens) ? localTokens.slice(0, 10) : [] },
    cfg,
    timeout: 30000
  })
}

async function fetchQrStatus(cfg, { qrcode: token, verifyCode, host = LOGIN_BASE_URL }) {
  return apiRequest(host, '/ilink/bot/get_qrcode_status', {
    method: 'GET',
    query: { qrcode: token, verify_code: verifyCode },
    cfg,
    timeout: 40000
  })
}

function printTerminalQr(content, logger) {
  logger.info('请用手机微信扫描以下二维码（或打开登录页）：')
  qrcode.generate(content, { small: true }, (qr) => console.log(qr))
}

function askTerminal(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(promptText, (ans) => { rl.close(); resolve(ans.trim()) }))
}

/**
 * 单轮登录周期：生成一个二维码并轮询，直到成功（返回凭据）或二维码过期（抛错）。
 */
async function loginCycle({ cfg, logger, dataDir, store, page, localTokens }) {
  let host = cfg.loginBaseUrl || LOGIN_BASE_URL
  let refreshes = 0
  while (refreshes <= MAX_QR_REFRESH) {
    const qr = await fetchQrCode(cfg, localTokens)
    const content = qr?.qrcode_img_content || qr?.qrcode || ''
    const token = qr?.qrcode || ''
    if (!content || !token) throw new Error('获取二维码失败：响应缺少 qrcode/qrcode_img_content')
    printTerminalQr(content, logger)
    page?.setState({
      status: 'wait',
      message: '等待扫码',
      qrcodeContent: content,
      qrImageUrl: makeQrImageUrl(content)
    })

    let verifyCode = ''
    for (;;) {
      let st
      try {
        st = await fetchQrStatus(cfg, { qrcode: token, verifyCode, host })
      } catch (e) {
        if (e.code === 'ETIMEDOUT') continue // 长轮询超时正常
        throw e
      }
      const status = st?.status || 'wait'
      logger.debug('二维码状态：', status)
      page?.setState({ status, message: st?.errmsg || '' })

      if (status === 'wait') continue
      if (status === 'scaned') {
        logger.info('已扫码，请在手机上确认登录')
        continue
      }
      if (status === 'scaned_but_redirect') {
        if (st.redirect_host) {
          host = /^https:\/\//.test(st.redirect_host) ? st.redirect_host : `https://${st.redirect_host}`
          logger.info('切换到重定向主机继续轮询')
        }
        continue
      }
      if (status === 'need_verifycode') {
        page?.setState({ status, message: '需要数字配对码' })
        logger.warn('需要数字配对码，请查看手机微信显示的数字（登录页或终端输入）')
        verifyCode = page ? await page.waitForVerifyCode() : await askTerminal('请输入手机微信显示的数字配对码：')
        continue
      }
      if (status === 'verify_code_blocked') {
        throw new Error('配对码错误次数过多')
      }
      if (status === 'binded_redirect') {
        const local = loadCredentials(dataDir)
        if (local) {
          logger.info('已绑定，复用本地凭据')
          return local
        }
        throw new Error('服务端提示已绑定但本地无凭据')
      }
      if (status === 'expired') break
      if (status === 'confirmed') {
        if (!st.bot_token) throw new Error('登录确认但未返回 bot_token')
        const creds = saveCredentials(dataDir, {
          token: st.bot_token,
          baseUrl: st.baseurl || LOGIN_BASE_URL,
          botId: st.ilink_bot_id || '',
          userId: st.ilink_user_id || ''
        })
        store?.set('login.localTokens', [...new Set([st.bot_token, ...localTokens])].slice(0, 10))
        logger.info(`登录成功：botId=${creds.botId || '-'}`)
        return creds
      }
      // 其他未知状态：继续轮询
    }
    refreshes += 1
    logger.warn(`二维码已过期，刷新中（${refreshes}/${MAX_QR_REFRESH}）`)
  }
  throw new Error('二维码多次过期')
}

/**
 * 执行登录，返回凭据对象 { token, baseUrl, botId, userId }。
 * 永不主动放弃：任一轮失败都会等待后重新生成二维码。
 */
export async function runLogin({ cfg, logger, dataDir, store }) {
  const localTokens = []
  const stored = store?.get('login.localTokens', [])
  if (Array.isArray(stored)) localTokens.push(...stored)

  const page =
    cfg.loginPage?.enabled !== false
      ? createLoginPage({ host: cfg.loginPage.host, port: cfg.loginPage.port, logger })
      : null
  if (page) await page.listen().catch((e) => logger.warn('登录页启动失败，仅使用日志二维码：', e.message))

  try {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await loginCycle({ cfg, logger, dataDir, store, page, localTokens })
      } catch (err) {
        const delay = Math.min(5000 * attempt, 60000)
        logger.warn(`登录未完成（${err.message}），${Math.round(delay / 1000)} 秒后重新开始…`)
        await sleep(delay)
      }
    }
  } finally {
    if (page) await page.close().catch(() => {})
  }
}
