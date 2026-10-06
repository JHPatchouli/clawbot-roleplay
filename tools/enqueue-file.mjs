#!/usr/bin/env node
/**
 * 把文件加入「待发件箱」：下次该用户给 Bot 发消息时自动补发。
 * 用法：DATA_DIR=/app/data node tools/enqueue-file.mjs <userId> <filePath> [显示文件名]
 */
import fs from 'node:fs'
import path from 'node:path'
import { enqueue } from '../src/util/outbox.js'

const DATA = process.env.DATA_DIR || '/app/data'
const [to, file, nameArg] = process.argv.slice(2)
if (!to || !file) {
  console.error('用法：node tools/enqueue-file.mjs <userId> <filePath> [显示文件名]')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error('文件不存在：' + file)
  process.exit(1)
}
const n = enqueue(DATA, { userId: to, name: nameArg || path.basename(file), path: path.resolve(file) })
console.log('已入队（当前 ' + n + ' 项）→ ' + to)
