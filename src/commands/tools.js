/**
 * 工具命令：查看工具状态、开关、配置联网搜索。
 */
import { maskSecret } from '../tools/store.js'

const PROVIDERS = ['bocha', 'tavily', 'brave', 'serper', 'searxng']

export function registerToolCommands(router) {
  router.register({
    name: 'tools',
    aliases: ['tool'],
    description: '工具调用：状态 / test / on|off / web provider|key|url',
    run: async ({ args, services }) => {
      const { tools, toolStore, providers, configStore, config, reply } = services
      const [sub, a, ...rest] = args

      // ---- 自检：逐个试跑（不联网的部分一定跑；联网的没配就跳过） ----
      if (sub === 'test') {
        const t0 = Date.now()
        const L2 = ['🧪 工具自检']

        const r1 = await tools.run('current_time', {})
        L2.push((r1.ok ? '✅' : '❌') + ' current_time → ' + String(r1.text).split('\n')[0])

        // 沙箱写→读→删 往返（自检文件用完就删，不留垃圾）
        const w = await tools.run('file_write', { path: '_selftest.md', content: '自检 ' + new Date().toISOString() })
        const rd = await tools.run('file_read', { path: '_selftest.md' })
        const del = await tools.run('file_delete', { path: '_selftest.md' })
        const sandboxOk = w.ok && rd.ok && del.ok
        L2.push((sandboxOk ? '✅' : '❌') + ' 沙箱写/读/删 → ' + (sandboxOk ? '正常' : [w, rd, del].map((x) => x.text).join(' | ')))

        // 越界拦截（这是安全底线，必须是 ❌ 才对）
        const esc = await tools.run('file_read', { path: '../store.json' })
        L2.push((esc.ok ? '❌' : '✅') + ' 越界拦截 → ' + (esc.ok ? '竟然成功了，这是漏洞！' : '已拒绝'))

        // SSRF 拦截：直连 IP，不依赖 DNS/网络
        const ssrf = await tools.run('web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' })
        L2.push((ssrf.ok ? '❌' : '✅') + ' SSRF 拦截 → ' + (ssrf.ok ? '竟然成功了，这是漏洞！' : '已拒绝'))

        const web = toolStore.get().web || {}
        if (web.apiKey || web.provider === 'searxng') {
          const s = await tools.run('web_search', { query: 'test', count: 1 })
          L2.push((s.ok ? '✅' : '❌') + ' web_search → ' + (s.ok ? '可用' : String(s.text).slice(0, 90)))
          const f = await tools.run('web_fetch', { url: 'https://example.com' })
          L2.push((f.ok ? '✅' : '❌') + ' web_fetch → ' + (f.ok ? '可用' : String(f.text).slice(0, 90)))
        } else {
          L2.push('⏭ web_search / web_fetch 跳过（未配搜索密钥：/tools web key <密钥>）')
        }

        L2.push('', '耗时 ' + (Date.now() - t0) + 'ms')
        return reply(L2.join('\n'))
      }

      // ---- 开关 ----
      if (sub === 'on' || sub === 'off') {
        configStore.set({ tools: { enabled: sub === 'on' } })
        return reply('工具调用：' + (sub === 'on' ? '开启' : '关闭') + '（下一轮对话生效）')
      }

      // ---- 联网搜索配置 ----
      if (sub === 'web') {
        const [what, ...more] = [a, ...rest]
        const val = more.join(' ').trim()
        if (what === 'provider') {
          if (!PROVIDERS.includes(val)) return reply('可选：' + PROVIDERS.join(' | '))
          toolStore.set({ web: { provider: val } })
          return reply('搜索服务商已设为：' + val + (val === 'searxng' ? '\n还需配置实例地址：/tools web url <地址>' : '\n注意：切换服务商后需要重设密钥 /tools web key <key>'))
        }
        if (what === 'key') {
          if (!val) return reply('用法：/tools web key <密钥>')
          toolStore.set({ web: { apiKey: val } })
          return reply('已保存搜索密钥：' + maskSecret(val) + '（服务商 ' + toolStore.get().web.provider + '）')
        }
        if (what === 'url') {
          if (!/^https?:\/\//i.test(val)) return reply('用法：/tools web url https://你的-searxng-实例')
          toolStore.set({ web: { searxngUrl: val.replace(/\/+$/, '') } })
          return reply('SearXNG 实例地址已设为：' + val)
        }
        return reply('用法：/tools web provider <' + PROVIDERS.join('|') + '>　/tools web key <密钥>　/tools web url <地址>')
      }

      // ---- 状态总览 ----
      const enabled = tools.enabled() && config.tools?.enabled !== false
      const native = providers.toolsSupported()
      const web = toolStore.get().web || {}
      const list = tools.list()
      const L = []
      L.push('🧰 工具调用')
      L.push('· 状态：' + (enabled ? '开启' : '关闭') + '（/tools on|off 切换）')
      L.push('· 当前模型：' + (providers.active()?.chatModel || '-') + ' · 协议：' + (native ? '原生 function calling' : '提示词协议（该模型不支持原生 tools）'))
      const roots = tools.rootsFor ? tools.rootsFor(inbound?.userId) : [tools.workspace]
      L.push('· 她手边的目录（只能在这里读写，越界会被拒绝）：')
      for (const r of roots) L.push('　- ' + r)
      L.push('　（前者是委托产物与解压结果的落地处，后者是她的草稿本；同名冲突以第一个为准）')
      L.push('· 联网搜索：' + (web.provider || '-') + ' · 密钥 ' + maskSecret(web.apiKey) + (web.provider === 'searxng' ? ' · 实例 ' + (web.searxngUrl || '（未配置）') : ''))
      L.push('· 单轮最多往返：' + (config.tools?.maxRounds ?? 3) + ' 次 · 结果上限 ' + (config.tools?.maxResultChars ?? 4000) + ' 字')
      L.push('')
      L.push('可用工具（' + list.length + '）：')
      for (const t of list) {
        const ps = t.params.map((p) => p.name + (p.required ? '' : '?')).join(', ')
        L.push('· ' + t.name + '(' + ps + ')　' + t.desc)
      }
      L.push('')
      L.push('配置：/tools web provider <' + PROVIDERS.join('|') + '>　/tools web key <密钥>　/tools web url <地址>')
      L.push('自检：/tools test（逐个试跑，含越界与 SSRF 拦截）')
      await reply(L.join('\n'))
    }
  })
}
