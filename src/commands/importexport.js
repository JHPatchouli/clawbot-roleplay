/**
 * 导入/导出命令。
 * 导出统一以 JSON 文件形式发送（ClawBot 媒体接口）；发送失败时回退为文本。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { applyImport, exportSnapshot, previewImport, diffConfig, formatDiff, DOUBLE_CONFIRM_KINDS } from '../import/importer.js'
import { makeCarrierPng } from '../util/carrier.js'
import { getCurrentCharacter, setCurrentCharacterId } from '../roleplay/character.js'
import { clip } from '../memory/score.js'

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * 导入完角色后，若当前**还没有**当前角色，就启用导入的第一个。
 *
 * 为什么需要：清空角色再全量导入是最常见的流程，而导入本身**不会**设置「当前角色」
 * （只有 /char use 会，见 roleplay/character.js）。不管的话，用户会看到机器人突然
 * 变成不扮演角色的普通助手，却不知道要再发一次 /char use 1。
 * 只在「没有当前角色」时动——用户已经选好的角色不抢。
 */
function maybeAdoptCharacter(services, userId, chars) {
  if (!chars || !chars.length) return null
  if (getCurrentCharacter(services.store, userId)) return null
  setCurrentCharacterId(services.store, userId, chars[0].id)
  return chars[0].name || chars[0].id
}

/**
 * 发一条**纯通知**消息：发送失败只记日志，绝不向上抛。
 *
 * 为何单独抽出来：导入会话后那条「正在补记忆…」原本在
 * try **外面**，而被通道限流卡了 3 分钟后抛了「发送失败（可能触发通道限流）」——
 * 异常一路冒到 /import 的 catch，用户看到「导入失败」，而补记忆**一次都没跑**，
 * 库是空的，于是之后所有召回全部未命中。
 * 通知发送失败时继续执行实际工作。
 */
async function notify(services, text) {
  try {
    await services.reply(text)
  } catch (e) {
    services.logger.warn('通知消息发送失败（不影响实际工作）：' + e.message)
  }
}

/**
 * 导入会话后**自动补记忆**。
 *
 * 场景：对方把旧客户端（旧客户端）删了，只剩一份导出的对话 JSON——
 * 记忆是聊出来的累积状态，不在导出文件里，所以「导入会话」本身补不回记忆，
 * 必须回头从对话正文里重新抽一遍。这一步以前没有，导入完就只是多了一段历史。
 *
 * 会切片逐段抽（见 memory.backfillFromMessages），所以耗时按段数走，先回执再干活。
 *
 * ⚠️ msgs 必须由调用方把「**刚刚导入的那批消息**」传进来，而不是回头读 history：
 *   导入回执要分成好几段发，通道限流时可能拖几十秒到几分钟；这期间对方只要说一句，
 *   chat/history 的 MAX_TURNS=40 就会把前面挤掉（89 条被截成 40 条，
 *   于是只能抽出 4 条，而且抽到的还是当天那几句困惑对话）。
 */
async function backfillSessionMemories(services, inbound, session, msgs) {
  const memory = services.memory
  if (!memory || !memory.backfillFromMessages) return
  const list = Array.isArray(msgs) ? msgs : services.history.list(inbound.userId, session.id)
  if (!list.length) return
  const chars = list.reduce((a, m) => a + String(m.content || '').length, 0)
  const character = getCurrentCharacter(services.store, inbound.userId)
  await notify(
    services,
    '🧠 正在从这段会话补记忆（' + list.length + ' 条 / ' + chars + ' 字）…\n' +
      '会切片逐段抽取，需要一会儿；期间不用再发消息。'
  )
  try {
    const res = await memory.backfillFromMessages(list, {
      userId: inbound.userId,
      // 补出来的记忆属于**这段被导入的会话**（记忆默认按会话隔离）
      sessionId: session.id,
      characterId: character ? character.id : null,
      character
    })
    const lines = ['🧠 补记忆完成：扫描 ' + res.chunks + ' 段（' + res.chars + ' 字），新增 ' + res.added.length + ' 条']
    if (!res.added.length) {
      lines.push('（没找到新的可记忆事实，或都与已有记忆重复）')
    } else {
      // ⚠️ 这里**故意把列表并成一行**，不要改成一行一条：
      // 微信发送是按换行分段、**一段一条消息**，而限流最狠时是 1 条/15 秒——
      // 列 12 条就要 3 分钟才发得完。
      // 并成一行既不容易被限流卡，也不至于刷屏。
      const head = res.added.slice(0, 5).map((m, i) => (i + 1) + '. ' + clip(m.text, 26))
      lines.push(head.join('　'))
      if (res.added.length > 5) lines.push('…共 ' + res.added.length + ' 条')
      lines.push('看全部：/mem　场景与原文出处：/mem show <序号>　删掉：/mem del <序号>')
    }
    return notify(services, lines.join('\n'))
  } catch (e) {
    // 抽取本身失败才是「失败」；这里也走 notify——如果连报错都发不出去，
    // 至少日志里有，不能让异常再冒到上层把它说成「导入失败」
    services.logger.warn('补记忆失败：' + e.message)
    return notify(services, '补记忆失败：' + e.message)
  }
}

/**
 * 导出 JSON：
 *  - 始终落盘到 data/exports/<name>（可用 SCP 直接取）
 *  - 通道发送：默认 file（JSON 原文件，无损）
 *    ⚠️ image（图片载体）会被微信压缩而损坏载荷，仅作兼容保留（旧客户端）
 *    ⚠️ 若账号文件出站不可用，可切 /exportmode text（文本分段）
 */
export async function sendJsonExport(services, inbound, name, obj) {
  const text = JSON.stringify(obj, null, 2)
  const bytes = Buffer.byteLength(text)
  // 落盘
  let savedPath = ''
  try {
    const dir = path.join(services.dataDir || 'data', 'exports')
    fs.mkdirSync(dir, { recursive: true })
    savedPath = path.join(dir, name)
    fs.writeFileSync(savedPath, text)
  } catch (e) {
    services.logger.warn('导出落盘失败：', e.message)
  }

  const mode = (services.config.export?.mode || 'file').toLowerCase()
  const sum = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)

  if (mode === 'image') {
    // 图片载体：把 JSON 附加在 PNG 源数据里发送（绕过文件出站限制）
    const png = makeCarrierPng(240, 240, text)
    await services.channel.sendImage(inbound.userId, png, inbound.contextToken)
    await services.reply(
      '📦 ' + name + '（' + bytes + 'B，sha256:' + sum + '）\n' +
      '已以「图片载体」发送（JSON 藏在图片源数据中）。\n' +
      (savedPath ? '容器内副本：' + savedPath + '\n' : '') +
      '\n保存该图片后执行：node tools/extract-payload.mjs 图片.png [输出.json]\n' +
      '或把这张图片发回给我，我会自动解出内容。'
    )
    return
  }

  if (mode === 'file') {
    try {
      await services.reply('📦 ' + name + '（' + bytes + 'B，sha256:' + sum + '）' + (savedPath ? '\n容器内副本：' + savedPath : ''))
      await services.channel.sendFile(inbound.userId, Buffer.from(text, 'utf8'), name, inbound.contextToken)
      return
    } catch (e) {
      services.logger.warn('文件发送失败，改用文本：', e.message)
      await services.reply('⚠️ 文件发送失败（' + e.message + '），改为文本发送。')
    }
  }

  // text 模式
  await services.reply('📦 ' + name + '（' + bytes + 'B）' + (savedPath ? '\n容器内副本：' + savedPath : '') + '\n\n--- JSON 开始 ---')
  await services.channel.sendRaw(inbound.userId, text, inbound.contextToken)
  await services.reply('--- JSON 结束 ---')
}

export function registerImportExportCommands(router) {
  router.register({
    name: 'import',
    description: '确认导入刚收到的文件（confirm=合并 / replace=覆盖 / cancel=取消）',
    run: async ({ inbound, args, services }) => {
      const sessions = services.sessions
      const store = services.store
      const reply = services.reply
      const sub = (args[0] || '').toLowerCase()
      const state = sessions.get(inbound.userId)
      const pending = state && state.pendingImport
      if (!pending) {
        return reply('没有待导入的文件。请先把 JSON 文件（或 JSON 文本）发给我。')
      }
      if (sub === 'cancel') {
        sessions.clear(inbound.userId)
        return reply('已取消导入。')
      }
      const mode = sub === 'replace' ? 'replace' : 'merge'
      const pPreview = previewImport(pending)
      // 破坏性导入（系统设置 / Provider / 全量备份）需二次确认：
      // 第一次 confirm 只展示「将要写入什么」，第二次才真正落盘。
      if (DOUBLE_CONFIRM_KINDS.includes(pPreview.kind) && !state.importConfirmed) {
        sessions.set(inbound.userId, { ...state, importConfirmed: true })
        const lines = ['⚠️ 即将写入全局配置：' + pPreview.label]
        if (pPreview.kind === 'settings' && pending.config) {
          const changes = diffConfig(services.configStore.get(), pending.config)
          lines.push('', '变更 ' + changes.length + ' 项：', ...(changes.length ? formatDiff(changes) : ['（无变化）']))
        }
        if (pPreview.kind === 'providers') {
          lines.push('', 'Provider：' + (Object.keys(pending.providers || {}).join('、') || '（无）'))
        }
        if (pPreview.kind === 'backup') {
          const has = [pending.config ? '系统设置' : null, pending.providers ? 'Provider' : null, pending.roleplay ? '角色扮演资产' : null].filter(Boolean)
          lines.push('', '备份含：' + (has.join('、') || '（无）'))
        }
        lines.push('', '这是写入本地配置的操作，不可撤销。')
        lines.push('确认无误请再回复一次（' + (mode === 'replace' ? '/import replace' : '/import confirm') + '）；取消：/import cancel')
        return reply(lines.join('\n'))
      }
      try {
        const p = previewImport(pending)
        const results = []
        // 导入快照里带来的记忆**没有向量**（快照的 vectors 不导入，见 importer.memoryIds 的注释），
        // 先收集起来，写完统一重算
        let reembedIds = []
        // 导入会话后要自动补记忆（记忆不在导出文件里，只能回头从正文重抽）
        let backfillSession = null
        if (p.kind === 'roleplay-snapshot' || p.kind === 'character-card') {
          const res = applyImport(store, pending, { mode, userId: inbound.userId })
          reembedIds = res.memoryIds || []
          const adopted = maybeAdoptCharacter(services, inbound.userId, res.characters)
          if (adopted) results.push('已启用角色「' + adopted + '」')
          results.push('角色 +' + res.counts.characters, '世界书 +' + res.counts.lorebook, '记忆 +' + res.counts.memories)
          if (res.counts.globalized) {
            results.push('其中 ' + res.counts.globalized + ' 条原属导出方的会话，已转为**全局**（本机没有那个会话，留着就等于藏起来看不到）')
          }
        } else if (p.kind === 'settings') {
          services.configStore.set(pending.config || {})
          results.push('系统设置已导入')
        } else if (p.kind === 'providers') {
          const n = services.providerStore.importProviders(pending.providers || {})
          results.push('Provider 导入 ' + n + ' 个（省略后的密钥不覆盖本地）')
        } else if (p.kind === 'backup') {
          if (pending.config) {
            services.configStore.set(pending.config)
            results.push('设置 ✔')
          }
          if (pending.providers) {
            const n = services.providerStore.importProviders(pending.providers)
            results.push('Provider ' + n + ' 个')
          }
          if (pending.roleplay) {
            const res = applyImport(store, { kind: 'roleplay-snapshot', data: pending.roleplay }, { mode, userId: inbound.userId })
            reembedIds = res.memoryIds || []
            const adopted = maybeAdoptCharacter(services, inbound.userId, res.characters)
            if (adopted) results.push('已启用角色「' + adopted + '」')
            results.push('角色 +' + res.counts.characters + '／世界书 +' + res.counts.lorebook + '／记忆 +' + res.counts.memories)
            if (res.counts.globalized) results.push('其中 ' + res.counts.globalized + ' 条记忆已转为全局')
          }
          const sc = Array.isArray(pending.sessions) ? pending.sessions.length : 0
          const hk = pending.histories ? Object.keys(pending.histories).length : 0
          if (sc) results.push('备份含 ' + sc + ' 个会话（历史 ' + hk + ' 段）：如需恢复会话，导出单会话 JSON 后用 /import')
        } else if (p.kind === 'session') {
          const s = services.chatSessions.create(inbound.userId, (p.session && p.session.name) || '导入会话')
          // 用 p.messages（已归一化，兼容「消息嵌在 session 里、字段叫 text」的 Web 端导出），
          // 不能用 pending.messages——那种格式根本没有顶层 messages
          services.history.set(inbound.userId, s.id, p.messages || [])
          results.push('会话「' + s.name + '」导入 ' + ((p.messages || []).length) + ' 条（含思考链）')
          // 把**刚导入的这批消息**带上：补记忆不能回头读 history（会被 40 条上限截掉）
          backfillSession = { session: s, messages: p.messages || [] }
        } else {
          throw new Error('暂不支持导入该类型')
        }
        sessions.clear(inbound.userId)
        // 给刚导入的记忆补向量（导入只带记忆本体，不带向量）。
        // 没配向量模型时不能假装无事：这些记忆会「看得到但语义检索不到」，得说出来。
        if (reembedIds.length) {
          const v = await services.memory.reembed(reembedIds, { userId: inbound.userId })
          if (v.embedded) results.push('记忆向量重算 ' + v.embedded + ' 条' + (v.failed ? '（失败 ' + v.failed + '）' : ''))
          else if (v.skipped === reembedIds.length) {
            results.push('⚠️ 未配向量模型：这 ' + reembedIds.length + ' 条记忆只能靠关键词召回（配好向量模型后用 /mem reembed 重算）')
          }
        }
        const lines = ['导入完成（' + (mode === 'replace' ? '覆盖' : '合并') + '）：']
        for (const r of results) lines.push('· ' + r)
        lines.push('')
        if (!backfillSession) lines.push('用 /dashboard 或 /char list 查看结果。')
        if (backfillSession) {
          // ⚠️ 每条 `\n` 都是一条微信消息，而限流最狠时 1 条/15 秒——
          // 这里原本是 8 行（= 8 条消息，最长 2 分钟），现在压成 2 行。
          // 三件对方一定会遇到、但看返回值看不出来的事，合并说：
          //  ① 旧对话排版会被当范例模仿；② 历史超 40 条会被自动截到最近 40 条；
          //  ③ 补出的记忆只属于这个会话（记忆按会话隔离）。
          lines.push(
            '提醒：旧对话会被当范例模仿（旧版爱用 ```(表情)```）；历史超 40 条会自动只留最近 40 条；补出的记忆只属于这个会话（要跨会话先 /mem global all）。',
            '🧠 正在从正文补记忆（导出文件里不含记忆），跑完会再发一条。'
          )
        }
        // 数据已经落盘了，从这里开始发的都是**回执**：
        // ⚠️ 回执发送失败绝不能再说成「导入失败」——用户会以为白导了一次，
        // 实际数据好好地在库里。
        await notify(services, lines.join('\n'))
        // 补记忆放在回执之后：切片抽取要跑好几轮模型调用，不能把导入回执一起拖住
        if (backfillSession) await backfillSessionMemories(services, inbound, backfillSession.session, backfillSession.messages)
      } catch (e) {
        services.logger.error('导入失败：', e.message)
        await notify(services, '导入失败：' + e.message)
      }
    }
  })

  router.register({
    name: 'exportmode',
    aliases: ['emode'],
    description: '配置导出传输方式：/exportmode image|text|file',
    run: async ({ args, services }) => {
      const modes = ['image', 'text', 'file']
      const m = (args[0] || '').toLowerCase()
      if (!modes.includes(m)) {
        return services.reply(
          '当前导出方式：' + (services.config.export?.mode || 'file') + '\n' +
            '可选：/exportmode file（JSON 原文件·推荐）| text（文本分段）| image（图片载体·不推荐）\n' +
            '⚠️ image 模式会被微信压缩，载荷可能损坏（配置传输请优先用 file）'
        )
      }
      services.configStore.set({ export: { mode: m } })
      if (m === 'image') {
        return services.reply(
          '导出方式已设为：image\n⚠️ 微信会压缩图片，载体会损坏，仅适合小体积容错场景；建议用 /exportmode file。'
        )
      }
      return services.reply('导出方式已设为：' + m)
    }
  })

  router.register({
    name: 'export',
    aliases: ['backup'],
    description: '导出为 JSON 文件：/export [roleplay|settings|providers|all] （providers 可加 full 含密钥）',
    run: async ({ inbound, args, services }) => {
      const store = services.store
      const reply = services.reply
      const what = (args[0] || 'roleplay').toLowerCase()
      const withSecrets = args.includes('full') || args.includes('--with-secrets')
      const base = { app: 'demo', exportedAt: Date.now() }

      if (what === 'roleplay' || what === 'rp') {
        const snap = exportSnapshot(store, inbound.userId)
        return sendJsonExport(services, inbound, 'app-roleplay-' + stamp() + '.json', snap)
      }
      if (what === 'settings' || what === 'config') {
        const payload = { ...base, kind: 'app-settings', version: 1, config: services.configStore.get() }
        return sendJsonExport(services, inbound, 'app-settings-' + stamp() + '.json', payload)
      }
      if (what === 'providers') {
        const payload = { ...base, kind: 'app-providers', version: 1, active: services.providerStore.activeId, providers: services.providerStore.export({ withSecrets }).providers }
        return sendJsonExport(services, inbound, 'app-providers-' + stamp() + '.json', payload)
      }
      if (what === 'memories' || what === 'mem') {
        const payload = { ...base, kind: 'app-memories', version: 1, memories: services.memory.list(inbound.userId) }
        return sendJsonExport(services, inbound, 'app-memories-' + stamp() + '.json', payload)
      }
      if (what === 'summaries' || what === 'sum') {
        const payload = { ...base, kind: 'app-summaries', version: 1, summaries: services.summary.list() }
        return sendJsonExport(services, inbound, 'app-summaries-' + stamp() + '.json', payload)
      }
      if (what === 'chat' || what === 'session') {
        const session = services.chatSessions.current(inbound.userId)
        const messages = services.history.list(inbound.userId, session.id)
        const payload = {
          ...base,
          kind: 'app-session',
          version: 1,
          source: 'clawbot',
          session: { id: session.id, name: session.name, userName: session.userName || '' },
          messages
        }
        return sendJsonExport(services, inbound, 'app-session-' + stamp() + '.json', payload)
      }
      if (what === 'all') {
        // 只导出自己的会话（之前会把所有用户的历史一起打包）
        const sessions = store.collection('sessions').list().filter((s) => s.userId === inbound.userId)
        const histories = {}
        for (const s of sessions) histories[s.id] = store.get('chat:' + s.userId + ':' + s.id, [])
        const payload = {
          ...base,
          kind: 'app-backup',
          version: 1,
          config: services.configStore.get(),
          providers: services.providerStore.export({ withSecrets: false }).providers,
          roleplay: exportSnapshot(store, inbound.userId).data,
          sessions,
          histories
        }
        return sendJsonExport(services, inbound, 'app-backup-' + stamp() + '.json', payload)
      }
      await reply(
        '导出（JSON 文件）：\n' +
          '/export roleplay　角色卡/世界书/记忆\n' +
          '/export settings　系统设置\n' +
          '/export providers　模型服务商（密钥省略）\n' +
          '/export providers full　含密钥\n' +
          '/export chat　当前会话（含思考链）\n' +
          '/export memories　记忆\n' +
          '/export summaries　总结\n' +
          '/export all　全量备份'
      )
    }
  })
}
