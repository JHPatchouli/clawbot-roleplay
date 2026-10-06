/**
 * 模型相关命令：/provider /key /model /thinking /embed /balance
 */
import { redact } from '../logger.js'
import { looksReasoning } from '../providers/catalog.js'

const mask = (k) => (k ? redact(k, 4) : '(未设置)')

export function registerProviderCommands(router) {
  // ---- /provider ----
  router.register({
    name: 'provider',
    aliases: ['prov'],
    description: '查看/切换模型服务商',
    run: async ({ args, services }) => {
      const { providers, reply } = services
      if (args[0] === 'use' && args[1]) {
        providers.setActive(args[1])
        const cfg = providers.active()
        return reply(`已切换 Provider：${args[1]}\n模型：${cfg.chatModel || '(未设置)'}\nKey：${mask(cfg.apiKey)}`)
      }
      const lines = ['模型服务商：']
      providers.list().forEach((p, i) => {
        lines.push(`${i + 1}. ${p.presetLabel} [${p.id}]${p.isActive ? ' ← 当前' : ''}`)
        lines.push(`   ${p.baseUrl}`)
        lines.push(`   模型：${p.chatModel || '(未设置)'}　Key：${mask(p.apiKey)}`)
      })
      lines.push('', '切换：/provider use <id>')
      await reply(lines.join('\n'))
    }
  })

  // ---- /key ----
  router.register({
    name: 'key',
    description: '设置/查看 API Key',
    run: async ({ args, services }) => {
      const { providers, reply } = services
      const [sub, a, b] = args
      if (sub === 'set') {
        const isProvider = a && providers.list().some((p) => p.id === a)
        const id = isProvider ? a : providers.activeId
        const key = isProvider ? b : a
        if (!key) return reply('用法：/key set <key>　或　/key set <provider> <key>')
        providers.setKey(id, key)
        return reply(`已保存 ${id} 的 API Key：${mask(key)}`)
      }
      if (sub === 'del') {
        const id = a || providers.activeId
        providers.setKey(id, '')
        return reply(`已清除 ${id} 的 API Key`)
      }
      const lines = ['API Key 状态：']
      providers.list().forEach((p) => lines.push(`· ${p.id}：${mask(p.apiKey)}`))
      await reply(lines.join('\n'))
    }
  })

  // ---- /model ----
  router.register({
    name: 'model',
    description: '列出/切换对话模型',
    run: async ({ args, services }) => {
      const { providers, reply } = services
      const cfg = providers.active()
      if (args[0] === 'refresh') {
        await reply('正在拉取模型列表…')
        try {
          const models = await providers.discover()
          return reply(`已获取 ${models.length} 个模型。发送 /model 查看。`)
        } catch (e) {
          return reply(`拉取失败：${e.message}`)
        }
      }
      if (args[0] === 'use' && args[1] != null) {
        const idx = Number(args[1])
        const models = providers.models()
        const name = Number.isInteger(idx) && idx >= 1 ? models[idx - 1] : args[1]
        if (!name) return reply('用法：/model use <序号或模型名>')
        providers.setModel(providers.activeId, name)
        return reply(`已切换模型：${name}`)
      }
      if (args[0] === 'set' && args[1]) {
        providers.setModel(providers.activeId, args[1])
        return reply(`已设置模型：${args[1]}`)
      }
      const models = providers.models()
      const lines = [`当前 Provider：${providers.activeId}　当前模型：${cfg.chatModel || '(未设置)'}`]
      if (!models.length) {
        lines.push('', '尚无模型缓存，发送 /model refresh 自动拉取。')
        lines.push('也可直接：/model set <模型名>')
      } else {
        lines.push('', `可用模型（回复 /model use <序号> 切换，共 ${models.length} 个）：`)
        models.slice(0, 30).forEach((m, i) => lines.push(`${i + 1}. ${m}`))
        if (models.length > 30) lines.push(`… 其余 ${models.length - 30} 个已省略`)
      }
      await reply(lines.join('\n'))
    }
  })

  // ---- /thinking ----
  router.register({
    name: 'thinking',
    aliases: ['think'],
    description: '查看/设置思考量',
    run: async ({ args, services }) => {
      const { providers, reply } = services
      const cfg = providers.active()
      const cap = providers.capability()
      const opts = cap.options || {}
      const [sub, val] = args

      if (sub === 'on' || sub === 'off') {
        providers.setThinking(providers.activeId, { enabled: sub === 'on' })
        return reply(`思考模式：${sub === 'on' ? '开启' : '关闭'}（${cfg.chatModel}）`)
      }
      if (sub === 'budget') {
        if (!opts.budgetRange) return reply('该 Provider 不支持思考预算，请用 /thinking effort <值>')
        const n = Number(val)
        const [min, max] = opts.budgetRange
        if (!n || n < min || n > max) return reply(`用法：/thinking budget <${min}-${max}>`)
        providers.setThinking(providers.activeId, { budget: n })
        return reply(`思考预算：${n} tokens（${cfg.chatModel}）`)
      }
      if (sub === 'effort') {
        const vals = opts.effortValues || []
        if (!vals.length) return reply('该 Provider 不支持 /thinking effort')
        if (!vals.includes(val)) return reply(`可选值：${vals.join(' | ')}`)
        providers.setThinking(providers.activeId, { effort: val })
        return reply(`思考强度：${val}（${cfg.chatModel}）`)
      }

      const lines = [
        `Provider：${providers.activeId}　模型：${cfg.chatModel || '(未设置)'}`,
        `· 是否推理模型：${looksReasoning(cfg.chatModel) ? '是' : '否'}`,
        `· 当前思考参数：${JSON.stringify(cap.thinking.params) || '无'}`
      ]
      if (opts.effortValues?.length) lines.push(`· 支持 effort：${opts.effortValues.join(' | ')}`)
      if (opts.budgetRange) lines.push(`· 支持 budget：${opts.budgetRange[0]}-${opts.budgetRange[1]}`)
      lines.push('', '设置：/thinking on|off')
      if (opts.effortValues?.length) lines.push(`　　　/thinking effort <${opts.effortValues.join('|')}>`)
      if (opts.budgetRange) lines.push('　　　/thinking budget <n>')
      await reply(lines.join('\n'))
    }
  })

  // ---- /balance ----
  router.register({
    name: 'balance',
    aliases: ['bal'],
    description: '查询账户余额（DeepSeek）',
    run: async ({ services }) => {
      const { providers, reply } = services
      try {
        const b = await providers.balance()
        const infos = Array.isArray(b?.balance_infos) ? b.balance_infos : []
        const lines = [`账户可用：${b?.is_available ? '是' : '否'}`]
        for (const i of infos) lines.push(`· ${i.currency || ''} 余额 ${i.total_balance ?? '-'}（赠金 ${i.granted_balance ?? '-'} / 充值 ${i.topped_up_balance ?? '-'}）`)
        if (!infos.length) lines.push(JSON.stringify(b))
        await reply(lines.join('\n'))
      } catch (e) {
        await reply(`余额查询失败：${e.message}`)
      }
    }
  })

  // ---- /embed ----
  router.register({
    name: 'embed',
    description: '配置向量模型',
    run: async ({ args, services }) => {
      const { providers, configStore, config, reply } = services
      if (args[0] === 'model' && args[1]) {
        // 写入向量专用配置（而非对话 Provider 的 embedModel）
        configStore.set({ embedding: { model: args[1] } })
        return reply('已设置向量模型：' + args[1])
      }
      if (args[0] === 'provider' && args[1]) {
        configStore.set({ embedding: { provider: args[1] } })
        return reply('向量 Provider 已设为：' + args[1])
      }
      const emb = config.embedding || {}
      const embProvider = emb.provider || '(跟随对话 Provider)'
      await reply(
        '向量配置：\n· Provider：' + embProvider + '\n· 模型：' + (emb.model || '(取该 Provider 的向量模型)') + '\n\n设置：/embed provider <id>　/embed model <名称>'
      )
    }
  })
}
