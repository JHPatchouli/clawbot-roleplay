/**
 * 文本主菜单：列出编号选项，用户回复数字即选中对应命令。
 */
export function registerMenu(router) {
  router.register({
    name: 'menu',
    aliases: ['m'],
    description: '打开主菜单',
    run: async ({ inbound, services }) => {
      const options = [
        { label: '角色扮演总览（角色卡/世界书/称呼/提示词）', cmd: '/rp' },
        { label: '仪表盘（配置/会话/角色总览）', cmd: '/dashboard' },
        { label: '查看运行状态', cmd: '/status' },
        { label: '模型与 Key（Provider / 模型 / 密钥）', cmd: '/provider' },
        { label: '思考量设置', cmd: '/thinking' },
        { label: '可用模型列表', cmd: '/model' },
        { label: '帮助', cmd: '/help' }
      ]
      services.sessions.set(inbound.userId, { options })
      const lines = ['主菜单（回复数字选择，5 分钟内有效）：']
      options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`))
      lines.push('', '回复 /cancel 取消。')
      await services.reply(lines.join('\n'))
    }
  })
}
