/**
 * 提示词查看命令。
 */
import { PROMPT_LIST, getPrompt } from '../prompts/index.js'
import { buildCharacterSystemPrompt } from '../roleplay/prompts.js'
import { getCurrentCharacter } from '../roleplay/character.js'

export function registerPromptCommands(router) {
  router.register({
    name: 'prompt',
    aliases: ['prompts', 'p'],
    description: '查看提示词配置：/prompt [key]　/prompt char 看当前角色组装结果',
    run: async ({ args, inbound, services }) => {
      const key = (args[0] || '').toLowerCase()
      if (!key) {
        const lines = ['提示词配置：']
        PROMPT_LIST.forEach((p, i) => {
          lines.push((i + 1) + '. ' + p.label)
          lines.push('   [' + p.key + '] ' + p.status + '　' + p.text.length + ' 字')
        })
        lines.push('', '查看全文：/prompt <key>')
        lines.push('当前角色组装结果：/prompt char')
        return services.reply(lines.join('\n'))
      }
      if (key === 'char' || key === 'persona') {
        const c = getCurrentCharacter(services.store, inbound.userId)
        if (!c) return services.reply('未选择角色。先用 /char use <序号>。')
        const text = buildCharacterSystemPrompt(c, { userName: services.config.roleplay?.userName })
        return services.reply('当前角色「' + c.name + '」的系统提示词（' + text.length + ' 字）：\n\n' + text)
      }
      const p = PROMPT_LIST.find((x) => x.key.toLowerCase() === key) || getPrompt(key)
      if (!p) return services.reply('未知 key。可用：' + PROMPT_LIST.map((x) => x.key).join('、'))
      return services.reply(p.label + '　[' + p.status + ']\n\n' + p.text)
    }
  })
}
