/**
 * 角色卡 / 世界书 基础命令。
 *
 * 多租户（P7）：列表只展示「自己的 + 共享的」；共享条目不可改删，
 * 可用 /char clone 复制为私有，或用 /char claim 把历史共享数据一次性收归自己。
 */
import { sendJsonExport } from './importexport.js'
import { scopedCollection } from '../storage/scope.js'
import { getCurrentCharacter, getCurrentCharacterId, setCurrentCharacterId } from '../roleplay/character.js'
import { buildCharacterSystemPrompt } from '../roleplay/prompts.js'
import { PROMPT_LIST } from '../prompts/index.js'

export function registerRoleplayCommands(router) {
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  router.register({
    name: 'char',
    aliases: ['character'],
    description: '角色卡：list / use / show / export / del / clone / claim',
    run: async ({ args, inbound, services }) => {
      const { store, reply } = services
      const uid = inbound.userId
      const col = scopedCollection(store, 'characters', uid)
      const list = col.list()
      const sub = (args[0] || 'list').toLowerCase()

      if (sub === 'list') {
        if (!list.length) return reply('暂无角色卡。把角色卡 JSON 文件发给我即可导入。')
        const cur = getCurrentCharacterId(store, uid)
        const lines = ['角色卡：']
        list.forEach((c, i) => lines.push(`${i + 1}. ${c.name}${c.id === cur ? ' ← 当前' : ''}${c.shared ? '（共享）' : ''}`))
        lines.push('', '启用：/char use <序号>　详情：/char show <序号>　删除：/char del <序号>')
        lines.push('共享角色可复制为私有：/char clone <序号>　把共享条目收归自己：/char claim')
        return reply(lines.join('\n'))
      }
      if (sub === 'use') {
        const c = pick(list, args[1])
        if (!c) return reply('序号无效，先发 /char list')
        setCurrentCharacterId(store, uid, c.id)
        // 切换角色：清空当前会话上下文（不再自动发送开场白）
        const session = services.chatSessions.current(inbound.userId)
        services.history.clear(inbound.userId, session.id)
        return reply('已切换到「' + c.name + '」，当前会话上下文已清空。直接发消息即可开始。')
      }
      if (sub === 'show') {
        const c = pick(list, args[1])
        if (!c) return reply('序号无效，先发 /char list')
        const lines = [
          `角色：${c.name}`,
          `描述：${(c.description || '—').slice(0, 200)}`,
          `性格：${(c.personality || '—').slice(0, 120)}`,
          `场景：${(c.scenario || '—').slice(0, 120)}`,
          `开场白：${(c.firstMes || '—').slice(0, 120)}`,
          `额外提示词：${c.systemPrompt ? '有' : '无'}`
        ]
        return reply(lines.join('\n'))
      }
      if (sub === 'export') {
        const c = pick(list, args[1])
        if (!c) return reply('用法：/char export <序号>')
        const payload = {
          app: 'demo',
          kind: 'character-card',
          spec: 'chara_card_v2',
          spec_version: '2.0',
          exportedAt: Date.now(),
          data: {
            name: c.name,
            description: c.description,
            personality: c.personality,
            scenario: c.scenario,
            first_mes: c.firstMes,
            mes_example: c.mesExample,
            system_prompt: c.systemPrompt,
            creator_notes: c.creatorNotes
          }
        }
        return sendJsonExport(services, inbound, 'app-char-' + stamp() + '.json', payload)
      }
      if (sub === 'del') {
        const c = pick(list, args[1])
        if (!c) return reply('序号无效，先发 /char list')
        if (c.shared) return reply('「' + c.name + '」是共享角色，不能直接删除。\n可用 /char clone ' + args[1] + ' 复制成自己的再删。')
        if (!col.remove(c.id)) return reply('无法删除：该角色不属于你。')
        if (getCurrentCharacterId(store, uid) === c.id) setCurrentCharacterId(store, uid, null)
        return reply(`已删除角色：${c.name}`)
      }
      if (sub === 'clone') {
        const c = pick(list, args[1])
        if (!c) return reply('用法：/char clone <序号>（先 /char list 看序号）')
        const { shared, ...rest } = c
        const copy = {
          ...rest,
          id: 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          ownerId: uid,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        col.put(copy)
        return reply('已复制为私有角色：「' + copy.name + '」\n可用 /char use 启用（不会影响原共享角色）。')
      }
      if (sub === 'claim') {
        // 迁移入口：P6 及之前的数据没有 ownerId，按共享对待；
        // 确认不再需要多人共享后可一次性收归自己。
        const n = { characters: 0, lorebook: 0, memories: 0 }
        for (const name of Object.keys(n)) {
          const raw = store.collection(name)
          for (const o of raw.list()) {
            if (o.ownerId) continue
            raw.put({ ...o, ownerId: uid })
            n[name]++
          }
        }
        const total = n.characters + n.lorebook + n.memories
        if (!total) return reply('没有可收归的共享条目（可能已经收归过了）。')
        return reply(
          '已把共享条目收归到你名下：\n' +
            '· 角色卡 ' + n.characters + '\n· 世界书 ' + n.lorebook + '\n· 记忆 ' + n.memories + '\n\n' +
            '⚠️ 收归后其他用户将不再看到这些条目。'
        )
      }
      return reply('用法：/char list | use <序号> | show <序号> | export <序号> | del <序号> | clone <序号> | claim')
    }
  })

  router.register({
    name: 'user',
    aliases: ['name'],
    description: '称呼：/user <称呼>=全局；/user session <称呼>=仅当前会话；/user reset=回退全局',
    run: async ({ args, inbound, services }) => {
      const { config, configStore, chatSessions, reply } = services
      const session = chatSessions.current(inbound.userId)
      const globalName = config.roleplay?.userName || '用户'
      const a = (args[0] || '').toLowerCase()

      if (!args.length) {
        const effective = session.userName || globalName
        return reply(
          '生效称呼：' + effective + '\n' +
            '· 全局：' + globalName + '\n' +
            '· 当前会话「' + session.name + '」：' + (session.userName || '（未设置，用全局）') + '\n\n' +
            '设置：/user <称呼>　/user session <称呼>　/user reset'
        )
      }
      if (a === 'reset' || a === 'clear') {
        chatSessions.setUserName(inbound.userId, session.id, '')
        return reply('已清除当前会话称呼，回退为全局：' + globalName)
      }
      if (a === 'session' || a === 'here') {
        const name = args.slice(1).join(' ').trim().slice(0, 20)
        if (!name) return reply('用法：/user session <称呼>')
        chatSessions.setUserName(inbound.userId, session.id, name)
        return reply('当前会话称呼已设为：' + name)
      }
      if (a === 'global') {
        const name = args.slice(1).join(' ').trim().slice(0, 20)
        if (!name) return reply('用法：/user global <称呼>')
        configStore.set({ roleplay: { userName: name } })
        return reply('全局称呼已设为：' + name + (session.userName ? '（当前会话仍用其独立称呼：' + session.userName + '）' : ''))
      }
      const name = args.join(' ').trim().slice(0, 20) || '用户'
      configStore.set({ roleplay: { userName: name } })
      return reply('全局称呼已设为：' + name)
    }
  })

  router.register({
    name: 'lore',
    aliases: ['world'],
    description: '世界书：list / export / del <序号>',
    run: async ({ args, inbound, services }) => {
      const { store, reply } = services
      const uid = inbound.userId
      const col = scopedCollection(store, 'lorebook', uid)
      const list = col.list()
      const sub = (args[0] || 'list').toLowerCase()
      if (sub === 'list') {
        if (!list.length) return reply('暂无世界书条目。导入角色卡或快照后会自动生成。')
        const lines = ['世界书条目：']
        list.slice(0, 30).forEach((e, i) => lines.push(`${i + 1}. ${e.active ? '📌' : '🔑'} ${e.title}${e.shared ? '（共享）' : ''}（触发词：${(e.keys || []).join('、') || '无'}）`))
        if (list.length > 30) lines.push(`… 其余 ${list.length - 30} 条已省略`)
        lines.push('', '删除：/lore del <序号>')
        return reply(lines.join('\n'))
      }
      if (sub === 'export') {
        const payload = {
          app: 'demo',
          kind: 'roleplay-snapshot',
          version: 1,
          exportedAt: Date.now(),
          data: { characters: [], lorebook: list, memories: [] }
        }
        return sendJsonExport(services, inbound, 'app-lore-' + stamp() + '.json', payload)
      }
      if (sub === 'del') {
        const e = pick(list, args[1])
        if (!e) return reply('序号无效，先发 /lore list')
        if (e.shared) return reply('「' + e.title + '」是共享条目，不能直接删除。')
        if (!col.remove(e.id)) return reply('无法删除：该条目不属于你。')
        return reply(`已删除世界书条目：${e.title}`)
      }
      return reply('用法：/lore list | export | del <序号>')
    }
  })

  // ---- /rp：角色扮演总览（一屏速查：角色卡 / 世界书 / 称呼 / 提示词） ----
  router.register({
    name: 'rp',
    aliases: ['roleplay', 'persona'],
    description: '角色扮演总览：角色卡 / 世界书 / 称呼 / 提示词（一屏速查）',
    run: async ({ inbound, services }) => {
      const { store, reply, config, chatSessions } = services
      const uid = inbound.userId
      const chars = scopedCollection(store, 'characters', uid).list()
      const lore = scopedCollection(store, 'lorebook', uid).list()
      const curId = getCurrentCharacterId(store, uid)
      const character = getCurrentCharacter(store, uid)
      const session = chatSessions.current(uid)
      const globalName = config.roleplay?.userName || '用户'
      const effectiveName = session.userName || globalName
      const trunc = (s, n) => (s ? String(s).slice(0, n) + (String(s).length > n ? '…' : '') : '')

      const L = []
      L.push('🎭 角色扮演总览')

      L.push('━━ 当前角色 ━━')
      if (character) {
        const persona = buildCharacterSystemPrompt(character, { userName: effectiveName })
        L.push('「' + character.name + '」' + (character.shared ? '（共享）' : ''))
        L.push('系统提示词组装后 ' + persona.length + ' 字')
        if (character.description) L.push('描述：' + trunc(character.description, 70))
        if (character.personality) L.push('性格：' + trunc(character.personality, 50))
        if (character.scenario) L.push('场景：' + trunc(character.scenario, 50))
        L.push('开场白 ' + (character.firstMes ? '有' : '无') + '（按设计不发送）· 额外提示词 ' + (character.systemPrompt ? '有' : '无'))
      } else {
        L.push('（未选择）用 /char use <序号> 启用；发角色卡 JSON 可导入')
      }

      L.push('━━ 角色卡 ' + chars.length + ' 张 ━━')
      if (!chars.length) L.push('（无）')
      else {
        chars.slice(0, 10).forEach((c, i) => {
          L.push(i + 1 + '. ' + c.name + (c.id === curId ? ' ← 当前' : '') + (c.shared ? '（共享）' : ''))
        })
        if (chars.length > 10) L.push('… 其余 ' + (chars.length - 10) + ' 张见 /char list')
      }

      const activeLore = lore.filter((e) => e.active).length
      L.push('━━ 世界书 ' + lore.length + ' 条 ━━')
      if (!lore.length) L.push('（无）导入角色卡时会自动生成')
      else {
        L.push('常驻 ' + activeLore + ' · 关键词触发 ' + (lore.length - activeLore) + (activeLore ? '（常驻每轮都会注入）' : ''))
        lore.slice(0, 6).forEach((e, i) => {
          L.push(i + 1 + '. ' + (e.active ? '📌' : '🔑') + ' ' + e.title + (e.shared ? '（共享）' : ''))
        })
        if (lore.length > 6) L.push('… 其余 ' + (lore.length - 6) + ' 条见 /lore')
      }

      L.push('━━ 称呼 ━━')
      L.push('生效：' + effectiveName + (session.userName ? '（本会话）' : '（全局）'))
      L.push('全局：' + globalName + (session.userName ? '　本会话「' + session.name + '」：' + session.userName : ''))

      L.push('━━ 提示词 ━━')
      L.push(PROMPT_LIST.map((p) => p.key + ' ' + p.text.length + '字').join(' · '))
      L.push('角色人设按卡动态生成；/prompt <key> 看全文，/prompt char 看组装结果')

      L.push('')
      L.push('/char　/lore　/user　/prompt　/rp')
      await reply(L.join('\n'))
    }
  })
}

function pick(list, idxArg) {
  const i = Number(idxArg)
  if (!Number.isInteger(i) || i < 1 || i > list.length) return null
  return list[i - 1]
}
