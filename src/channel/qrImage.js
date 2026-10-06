/**
 * 由二维码内容生成可展示的图片 URL。
 * iLink 的 qrcode_img_content 通常是「要编码的内容」，用公开 QR 服务渲染成图片；
 * 若它本身就是 http 图片链接，则直接使用。
 */
export function makeQrImageUrl(content, size = 280) {
  if (!content) return null
  if (/^https?:\/\//i.test(content)) return content
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(content)}`
}
