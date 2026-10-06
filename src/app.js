/**
 * 组装应用：配置 + 存储 + Provider + 命令路由 + ClawBot 通道。
 * 供 index.js 与 cli/simulate.js 共用。
 */
import path from 'node:path'
import { JsonStore } from './storage/jsonStore.js'
import { ProviderStore } from './providers/store.js'
import { createProviders } from './providers/index.js'
import { createLogger } from './logger.js'
import { createRouter } from './commands/router.js'
import { createSessions } from './commands/session.js'
import { createHistory } from './chat/history.js'
import { createChatSessions } from './chat/sessions.js'
import { createEmbedder } from './memory/embedding.js'
import { createVectorStore } from './memory/vectorStore.js'
import { createMemory } from './memory/memory.js'
import { createSummary } from './memory/summary.js'
import { ToolStore } from './tools/store.js'
import { createTools } from './tools/index.js'
import { createAgent } from './chat/agent.js'
import { createUsageMeter } from './usage.js'
import { registerBuiltin } from './commands/builtin.js'
import { registerMenu } from './commands/menu.js'
import { registerProviderCommands } from './commands/providers.js'
import { registerImportExportCommands } from './commands/importexport.js'
import { registerRoleplayCommands } from './commands/roleplay.js'
import { registerSessionCommands } from './commands/sessions.js'
import { registerMemoryCommands } from './commands/memory.js'
import { registerSummaryCommands } from './commands/summary.js'
import { registerDashboardCommand } from './commands/dashboard.js'
import { registerPromptCommands } from './commands/prompts.js'
import { registerToolCommands } from './commands/tools.js'
import { createPerception } from './perception/index.js'
import { registerPerceptionCommands } from './commands/perception.js'
import { createAsr } from './asr/index.js'
import { registerAsrCommands } from './commands/asr.js'
import { createDelegator } from './agent/delegate.js'
import { createProactive } from './agent/proactive.js'
import { createFollowup } from './agent/followup.js'
import { registerAgentCommands } from './commands/agent.js'
import { registerProactiveCommands } from './commands/proactive.js'
import { Channel } from './channel/channel.js'

export function createApp({ dataDir, configStore, store, logger, credentials }) {
  const config = configStore.get()
  const log = logger || createLogger(config.logLevel)
  const jsonStore = store || new JsonStore(path.join(dataDir, 'store.json'))
  const providerStore = new ProviderStore(dataDir)
  const providers = createProviders({ providerStore, logger: log })
  const sessions = createSessions(jsonStore)
  const history = createHistory(jsonStore)
  const chatSessions = createChatSessions(jsonStore)
  const vectorStore = createVectorStore(jsonStore)
  const embedder = createEmbedder({ providerStore, config })
  const memory = createMemory({ store: jsonStore, providers, providerStore, embedder, vectorStore, config, logger: log })
  const summary = createSummary({ store: jsonStore, providers, logger: log, config })
  const toolStore = new ToolStore(dataDir)
  // 委托器要在 tools 之前建：工具注册表会根据「框架装好了没」决定要不要暴露 delegate_task
  const delegator = createDelegator({ dataDir, config, logger: log, providerStore })
  // 「主动找你」的调度器在 channel 之后才建（需要通道才能发），但工具要先拿得到它 →
  // 传一个 getter（闭包拿到最终实例），而不是先建工具再补挂。
  let proactive = null
  const tools = createTools({ dataDir, config, toolStore, logger: log, memory, delegator, getProactive: () => proactive })
  const agent = createAgent({ providers, tools, config, logger: log })
  // 感知管理模块：时间感知等「每轮自动到达的客观事实」（见 src/perception/index.js）
  // 传 configStore 而不是 config：`/perc` 改完要**立即生效**，
  // 而 configStore.set 会替换掉 perception 这个子对象（顶层引用才保持有效）
  const perception = createPerception({ configStore, config, store: jsonStore, logger: log })
  // 语音识别：把对方发来的语音转成文字（入站输入的转换，见 src/asr/index.js）
  // 传 configStore 而不是 config：`/asr` 改完要**立即生效**
  const asr = createAsr({ configStore, config, providerStore, logger: log })
  // 启动就探一次 SILK 解码器（并写进日志）。理由与 sshd -T 那套一样：
  // 「以为装了其实没装 / 装错位置」这类问题只有到真收到语音时才暴露，而那时对方已经在等了。
  if (asr.status().enabled) {
    asr
      .probeCodec()
      .then((c) => log.info('[asr] 语音识别：' + asr.status().mode + ' 模式｜模型 ' + asr.status().model + '｜SILK 解码器 ' + (c.ok ? '已装' : '没装 — ' + c.reason)))
      .catch((e) => log.warn('[asr] 解码器探测失败（不影响启动）：' + e.message))
  }
  // 用量计：把每轮的 token 与**缓存命中**量看得到（此前 usage 被直接丢掉）
  const usage = createUsageMeter({ size: Number(config.llm?.usageWindow ?? 100) })

  const services = {
    store: jsonStore,
    config,
    configStore,
    logger: log,
    providers,
    providerStore,
    sessions,
    history,
    chatSessions,
    vectorStore,
    embedder,
    memory,
    summary,
    toolStore,
    tools,
    agent,
    delegator,
    perception,
    asr,
    usage,
    dataDir
  }
  const router = createRouter({ services })
  registerBuiltin(router)
  registerMenu(router)
  registerProviderCommands(router)
  registerImportExportCommands(router)
  registerRoleplayCommands(router)
  registerSessionCommands(router)
  registerMemoryCommands(router)
  registerSummaryCommands(router)
  registerDashboardCommand(router)
  registerPromptCommands(router)
  registerToolCommands(router)
  registerPerceptionCommands(router)
  registerAsrCommands(router)
  registerAgentCommands(router)
  registerProactiveCommands(router)

  let channel = null
  if (credentials) {
    channel = new Channel({      credentials,
      store: jsonStore,
      config,
      logger: log,
      // 待发队列要落盘（data/pending-replies.json），所以通道需要知道数据目录
      dataDir,
      onMessage: async (inbound, turn) => {
        await router.handle(inbound, {
          reply: (text) => channel.sendReply(inbound.userId, text, inbound.contextToken),
          typing: () => channel.sendTyping(inbound.userId, inbound.contextToken, 1),
          typingEnd: () => channel.sendTyping(inbound.userId, inbound.contextToken, 2),
          // 本轮时限的延长口子：会一路透传到工具层（委托自己会申请，见 tools/index.js）
          extendTimeout: turn?.extendTimeout,
          channel,
          store: jsonStore,
          config,
          logger: log,
          // 给 /pending 读待发队列文件用
          dataDir
        })
      }
    })
  }

  // 后台委托的「后续」：干完了由回调把结果交回给角色，让她自己用一两句话转达给对方
  // 
  // 没有通道（纯 CLI / simulate）时就没人可转达，不接线即可。
  if (channel) {
    try {
      delegator.setCallback(createFollowup({ services, channel }))
    } catch (e) {
      log.warn('委托回调接线失败（后台委托仍可用，只是结果不会自动转达）：' + e.message)
    }
  }

  // 主动消息：随机时间由角色先发送消息。
  // 默认**关**（config.proactive.enabled），`/proactive on|off` 可在线开关——这是回滚闸门：
  // 关掉即 stop()（定时器清掉），不需要改代码 / 重新部署。
  if (channel) {
    proactive = createProactive({
      config,
      store: jsonStore,
      logger: log,
      // 找得到「跟谁聊过」：kv 里每个 chat:<uid>:<sid> 就是一个聊过的人
      listUsers: () => {
        const kv = (jsonStore.data && jsonStore.data.kv) || {}
        const ids = new Set()
        for (const k of Object.keys(kv)) if (k.startsWith('chat:')) ids.add(k.slice(5).split(':')[0])
        return [...ids]
      },
      // 最后一次说话是什么时候（她说的或他说的都算）——刚聊完就不该去打扰
      lastActivityAt: (userId) => {
        try {
          const kv = (jsonStore.data && jsonStore.data.kv) || {}
          const sid = kv['currentSession:' + userId]
          const h = sid ? kv['chat:' + userId + ':' + sid] : null
          if (!Array.isArray(h) || !h.length) return 0
          return Number(h[h.length - 1].at) || 0
        } catch (_) {
          return 0
        }
      },
      fire: (userId) => router.initiateTurn(userId, { channel, trigger: 'scheduler' })
    })
    proactive.start()
  }

  return { config, configStore, store: jsonStore, logger: log, providers, providerStore, sessions, history, chatSessions, vectorStore, embedder, memory, summary, toolStore, tools, agent, delegator, perception, asr, usage, router, channel, proactive }
}
