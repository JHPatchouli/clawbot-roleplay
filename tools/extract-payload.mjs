#!/usr/bin/env node
/**
 * 从图片载体中提取 JSON。
 * 用法：node tools/extract-payload.mjs <图片文件> [输出.json]
 * 也支持标准输入：cat img.png | node tools/extract-payload.mjs - out.json
 */
import fs from 'node:fs'
import { extractText } from '../src/util/carrier.js'

const [input, output] = process.argv.slice(2)
if (!input) {
  console.error('用法：node tools/extract-payload.mjs <图片文件> [输出.json]')
  process.exit(1)
}
const buf = input === '-' ? fs.readFileSync(0) : fs.readFileSync(input)
const text = extractText(buf)
if (!text) {
  console.error('未在图片中找到 JSON 载荷（可能图片被平台重新编码）。')
  process.exit(2)
}
if (output) {
  fs.writeFileSync(output, text)
  console.log('已写出：' + output + '（' + Buffer.byteLength(text) + 'B）')
} else {
  process.stdout.write(text + '\n')
}
