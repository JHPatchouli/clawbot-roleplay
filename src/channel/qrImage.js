/**
 * 由二维码内容生成登录页可展示的 SVG。
 *
 * 参数与命令行 qrcode-terminal 保持一致：自动选择版本，纠错级别 L。
 * 微信返回的 qrcode_img_content 是扫码链接，不是图片地址，不能直接放进 <img>。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode-terminal/vendor/QRCode')
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')

function createMatrix(content) {
  const level = QRErrorCorrectLevel?.L ?? 1
  const qr = new QRCode(-1, level)
  qr.addData(String(content))
  qr.make()
  return qr.modules
}

export function renderQrSvg(content, size = 280) {
  if (!content || !QRCode) return ''
  const modules = createMatrix(content)
  const count = modules.length
  const quiet = 4
  const dimension = count + quiet * 2
  const cell = size / dimension
  const rects = []
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (!modules[y][x]) continue
      rects.push(
        `<rect x="${((x + quiet) * cell).toFixed(2)}" y="${((y + quiet) * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${rects.join('')}</svg>`
}

export function makeQrImageUrl(content) {
  const svg = renderQrSvg(content)
  return svg ? `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}` : null
}
