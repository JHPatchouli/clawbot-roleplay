/**
 * 服务端设置（配置项声明 + 默认值）。
 * 全部设置持久化到 data/config.json，可整体导出/导入 JSON（需求 6）。
 */

export const DEFAULT_CONFIG = {
  // 调用方标识（ClawBot base_info.bot_agent，仅用于日志归因）
  botAgent: 'ClawBot/0.1.0',
  // iLink 客户端协议版本（base_info.channel_version）
  channelVersion: '2.4.6',
  // 客户端版本编码来源（iLink-App-ClientVersion）
  appVersion: '2.4.6',
  // 二维码登录固定使用的主机
  loginBaseUrl: 'https://ilinkai.weixin.qq.com',
  logLevel: 'info',
  // 登录页（首次扫码用；默认只绑本机，配合 SSH 隧道访问）
  loginPage: { enabled: true, host: '127.0.0.1', port: 8080 },
  // 通道：单轮消息处理的时限（超过就回一句「处理这条消息出错」，并且这一轮的结果就废了）
  // 默认 150s：必须**大于** provider 自己的请求超时（client.js 里是 120s），
  // 否则慢一轮模型回复会被误判成超时。更久的活（委托）由工具层运行时申请延长。
  channel: { handleTimeoutMs: 150000 },
  // 「正在输入」状态（协议未完全公开，失败会被容错忽略）
  typing: { enabled: true },
  // 回复：单条长度上限 + 分句逐条发送
  // 间隔取保守安全值（文档：服务端无公开固定限速，需主动限流），并加抖动避免规律
  reply: {
    maxCharsPerMessage: 1800,
    segment: true,
    segmentDelayMs: 1200,
    segmentJitterMs: 500,
    // 自适应限流（AIMD）：窗口内最多 maxPerWindow 条，命中 ret=-2 时额度折半
    windowMs: 15000,
    maxPerWindow: 6,
    minPerWindow: 1,
    // 单条回复最多分几条：超过约 10 条时会出现 prepare failed，超出的分段会被合并
    maxSegmentsPerReply: 10,
    // 发不出去的内容不丢：落盘进待发队列（data/pending-replies.json），
    // 由通道按 pendingRetryMs 定期补发；pendingMaxItems 是队列条数上限，
    // 真到上限说明微信侧长期压制，此时会丢弃最旧的并打 ERROR 日志。
    // pendingMaxChunks：/cot、/export 这类「按长度切块」的发送，剩余块数超过它就不排队
    // 而是直接报错（长导出塞进队列会撞上限 → 尾部被静默截断）。
    pendingRetryMs: 60000,
    pendingMaxItems: 500,
    pendingMaxChunks: 20,
    // 图文合并窗口：图片到达后先等一小会儿，若用户紧接着补了一句话，
    // 就把「图 + 话」当成**一轮**交给模型，避免先答图片、再答那句话。
    // 聊天习惯常是「先发图、再补一句」，不合并就会连回两条。
    // 0 = 关闭（图一到就处理）；mergeMaxWaitMs 是连补多句时的总等待上限。
    mergeWindowMs: 2500,
    mergeMaxWaitMs: 8000
  },
  // 模型调用参数（限制「回复长度」而非分段条数）
  // maxTokens = null 表示跟随该模型在 catalog 中登记的最高值：
  //   换服务商/换模型时不用手改，也不会因为留着旧值把请求打 400。
  //   想收紧（省成本 / 让角色说得短一点）就在聊天里用 `/max reply <n>` 显式设定。
  //   这是**上限不是预留**：用不到不额外花钱（1024/8192/393216 三档输出无异）。
  llm: { maxTokens: null, temperature: null },
  // 工具调用（模型可用的外部能力）：密钥在 data/tools.json，不在这里
  tools: {
    enabled: true,
    // 一轮回复里最多允许几次「工具调用 → 结果」往返（防止循环烧 token）
    maxRounds: 3,
    // 单个工具结果注入上下文时的上限
    maxResultChars: 4000,
    files: { maxReadBytes: 65536, maxWriteBytes: 262144, maxSendPerTurn: 1, maxZipEntries: 500, maxZipBytes: 67108864, maxUnzipBytes: 67108864 },
    web: { timeoutMs: 15000, maxChars: 4000, searchCount: 5 }
  },
  // 感知：把「模型感知不到的客观事实」每轮自动喂给它（见 src/perception/）
  // 与 tools 的区别：工具是模型主动去查，感知是每轮自动到达（时间这种事等它想起来问就晚了）。
  // 事实走尾插（不破坏前缀缓存），「怎么用」走 system 里的固定规范（见 roleplay/prompts.js）。
  perception: {
    // 总开关：关掉后一个感知块都不注入
    enabled: true,
    // 时间感知（第一个能力）：当前时刻 + 距上次说话多久
    time: {
      enabled: true,
      // ⚠️ 容器里是 UTC，必须显式给时区，否则「现在几点」会差 8 小时
      timeZone: 'Asia/Shanghai',
      // 「距上次说话」超过这个小时数，才在注入内容里附一句行为提示。
      // 太短（比如 1 小时）会把角色教成每句都提时间；太长（比如 24 小时）则一天内的
      // 间隔全被当成「紧接着上一句」，语气失真。
      gapNoticeHours: 6
    },
    // 天气感知（第二个能力）：一个或多个地点的当前天气。
    // ⚠️ **位置必须显式配置**（`/perc city <备注> <lat,lon>`）：
    //   按服务器 IP 自动定位会得到机房所在城市，不是用户的城市——
    //   照那个自动定位会天天报错地方的天气，比不说更糟。
    // ⚠️ 默认 enabled 为 true 但**没配位置就等于不生效**（available() 会返回 false，
    //   `/perc` 如实显示「未设置位置」，也不占任何提示词）。
    // 相距几十公里的地方（家 / 公司）天气会不一样，所以是一份名单而不是一个点；
    // 备注会原样进提示词，角色靠它区分「哪边」。
    weather: {
      enabled: true,
      // 可插拔取数源：open-meteo（免费无 key）；qweather / caiyun 见 senses/weather.js 的 PROVIDERS
      provider: 'open-meteo',
      // 地点名单（优先）：[{ label, latitude, longitude }, ...]，最多 8 处
      places: [],
      // 旧的单点字段仍认：升级前设过的位置不会丢；一旦 places 里有有效坐标，就以名单为准
      latitude: null,
      longitude: null,
      // 单点时的展示名（只影响注入文本里那个括号，不参与取数）
      label: '',
      // 时区 / 取数超时 / 缓存与失败冷却
      timeZone: 'Asia/Shanghai',
      timeoutMs: 5000,
      // 昨天 + 今天起往后几天（含今天）。都并在同一次预报请求里，不加往返。
      pastDays: 1,
      forecastDays: 3,
      // 缓存多久：perceive() 是**拼提示词之前 await** 的，查询会拖慢每一轮，
      // 所以必须缓存；过期时用旧值 + 后台刷新，绝不为刷新拖慢当前这轮。
      ttlMinutes: 15,
      // 失败后冷却多久不再重试（否则 API 挂了会每轮白等一个超时）
      errorCooldownMinutes: 10,
      // 需要 key 的 provider 用（**绝不写进仓库**，走运行时配置）
      apiKey: ''
    }
  },
  // 语音识别（把对方发来的语音转成文字）：入站输入的转换，见 src/asr/
  // 为什么默认开：对方发语音时，以前整条消息会被**静默丢弃**（什么都不回）——
  // 那比报错糟得多。开启后即使识别失败也会回一句「没听清」，至少不是石沉大海。
  // 回滚：`/asr off` 或把 enabled 改回 false（解码器没装时会自动降级为「不可用」提示）。
  asr: {
    enabled: true,
    // 工作模式（设计要求：**先验证再接入**）：
    //   'probe' = 只把识别结果**回传给对方看**，绝不进对话：
    //             不写会话历史、不调模型、不注入记忆与感知 —— 先确认语音能正常收到与解析
    //   'chat'  = 把转写当成「他说的话」走正常一轮聊天（验证通过后再切）
    // 切法：/asr mode probe|chat
    mode: 'probe',
    // 用哪家的识别（默认硅基流动：它有 SILK 之外的多语言识别，且价格页显示有免费档）
    provider: 'siliconflow',
    // 测试过的三个模型都能把中文一句认全：
    //   XingChenASR-V3.2 **453ms（免费）**｜Qwen/Qwen3-ASR-1.7B 381ms｜
    //   FunAudioLLM/SenseVoiceSmall 正确但**冷启动 168s**（不用）
    model: 'XingChenAGI/XingChenASR-V3.2',
    // 微信语音（SILK）一般是 24kHz。SILK 头里**没有**采样率字段，猜错的后果是变速播放，
    // 所以解出来是空结果时会自动按 24000/16000/8000 再试一轮（见 asr/index.js）
    sampleRate: 24000,
    timeoutMs: 30000,
    // 说话人判定（口径：「这条里有没有第二个人在说话」）：
    // 文字仍由上面的普通模型出（质量更好），额外跑一次分离模型只为数人头。
    // ⚠️ **这个人数会误报**：单人一句「今天天气不错，你中午吃了什么？」
    //    被判成 **3 人说话**（两人对话样本判 2 是对的，但单人短句会被过分割）。
    //    所以默认 **notify=false**：人数只进 `/asr last` 与验证回执（供人判断），
    //    **不写进对话**——宁可不说，也不能让角色拿一个会错的推断当真事（与「不许编造」同一条铁律）。
    //    想试就 `/asr diar notify on`；确认可靠后再把默认改成 true。
    diarize: { enabled: true, notify: false, model: 'XingChenAGI/XingChenASR-Diarize-V3.0' },
    // 微信单条语音最长 60s，SILK 很小，4MB 足够；太小会把长语音拒掉，太大白烧内存
    maxBytes: 4194304
  },
  // 委托：把「需要动手做」的任务交给**成熟的 agent 框架**去干（默认 Claude Agent SDK）
  // 模型主动委托 → 框架在自己那边写脚本/跑命令/抓网页 → 把结论交回来（详见 src/agent/delegate.js）
  // ⚠️ 这是唯一一处「外部 agent 在容器里跑命令」的能力，隔离三件套：降权 nobody + 清洗 env + 命令闸门
  agent: {
    enabled: true,
    // 框架安装目录（空 = <dataDir>/../data-agent，即容器里的 /app/data-agent）
    installDir: '',
    sdkEntry: '', // 空 = <installDir>/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    runner: '', // 空 = src/agent/runner.mjs
    workDir: '', // 空 = <installDir>/work（按用户分目录）
    // 用哪家的 Key（默认与对话同源，不用再配一遍）；想单独开一把 Key 就填 apiKey
    provider: 'deepseek',
    // 委托专用 Key（空 = 回落到对话 Provider 的 Key）。聊天里改：/agent key <密钥>
    apiKey: '',
    model: 'deepseek-chat',
    // 第三方「Anthropic 兼容」端点（DeepSeek 的 /anthropic 可用）
    baseUrl: 'https://api.deepseek.com/anthropic',
    // 一轮委托最多几个往返（防跑飞、控成本）；超时是**硬**的，到点 SIGKILL
    // 8 → 12：找图/下附件这类任务的往返是「搜索 → 逐页抓 → 提取直链 → 逐个下载」，
    // 8 轮会在最后一步差一点跑不完；撞上限不会白干，会续跑 1 次并把已有产物交回来
    maxTurns: 12,
    // 撞到 maxTurns 后**接着同一个会话**续跑几次（0 = 不续跑）
    maxResumes: 1,
    // 后台队列最多排几件（同一时刻只跑一件）——挂了排比直接拒体验好，但也不能无限排
    maxQueue: 3,
    timeoutMs: 180000,
    // 硬超时 = timeoutMs + 这个余量（留给 runner 收到 abort 后优雅收尾、把部分结果交回来）
    killSlackMs: 15000,
    // 交回来的结论截断长度（它可能贴一大段，而我们的回复只有一两句）
    maxResultChars: 1500,
    // 降权到的身份（默认 nobody）；非 root 启动时自动忽略
    uid: 65534,
    gid: 65534
  },
  // 出站媒体
  media: {
    // 上传到 CDN 的重试与超时（CDN 会偶发 500 / 卡住，
    // 而 PUT 原来**没有超时**——卡住会把整轮拖到通道超时，用户只看到一句报错）
    uploadTries: 3,
    uploadTimeoutMs: 60000,
    // 已确认：video_item 用 video_size 就能正常发送；
    // 保留可配置是为了应对极端情况（不行时试 len / mid_size，无需改代码）
    videoSizeField: 'video_size',
    maxSendBytes: 20 * 1024 * 1024,
    maxVideoBytes: 10 * 1024 * 1024
  },
  // 主动消息：随机时间由角色先发送消息。
  // ⭐ 默认 **关闭**：这是一条「没有入站消息也会发出去」的路径，默认开等于默认会打扰人。
  //   开启：/proactive on；回滚：/proactive off（或把 enabled 改回 false）——不用改代码。
  proactive: {
    enabled: false,
    minGapMinutes: 60, // 随机间隔下限（分钟）
    maxGapMinutes: 240, // 上限；每次触发后重新随机
    minSilenceMinutes: 30, // 距上次说话至少这么久，刚聊完不来打扰
    maxPerDay: 3, // 每天最多主动几次（0 = 不限）
    quietFromHour: 23, // 静默时段（本地时区）：23 点到次日 9 点不开口
    quietToHour: 9,
    timeZone: 'Asia/Shanghai'
  },
  // 记忆与总结
  memory: {
    autoExtractEvery: 6, // 每 N 轮自动抽取一次（0=关闭）
    // 成本控制：会话文本过短就不值得调用模型抽取；过长则截断
    extractMinChars: 200,
    maxExtractChars: 4000,
    // 生成预算：**null = 跟随该模型的最高值**（与 llm.maxTokens 同一套语义）。
    // ⚠️ 别往小里调：思考型模型的**推理内容也计入 completion**，
    // 预算太小的话推理先把它吃满，content 就被截断成半截 JSON → 抽取静默归零。
    // 900 在长输入（2000 字以上）时会失败；而 maxTokens 是上限不是预留，用不到不花钱。
    // 聊天里改：/max extract <n|max>
    extractMaxTokens: null,
    // 剧情总结的生成预算（同样 null = 跟随模型最高值）。聊天里改：/max summary <n|max>
    summaryMaxTokens: null,
    extractMaxItems: 20,
    // 记忆范围：'session' = 只在本会话看得到自己抽出的记忆（默认）；
    // 'user' = 跨会话（旧行为）。不同会话常常在演不同的故事线，混在一起会让
    // A 线的约定搬进 B 线。要跨会话可见就把某条用 /mem global 提升为全局。
    scope: 'session',
    // 召回管线：稠密 + 稀疏(BM25) → RRF 融合 → 可选 rerank
    //   自动注入压到 3 条（沉浸感够用），想深挖交给 recall_memory 工具按需检索
    recallTopK: 3,
    // 每路粗排各取多少条候选进融合
    recallCandidates: 20,
    // 稠密那一路的余弦下限
    recallThreshold: 0.35,
    // 稀疏那一路的**相对**下限：分数不到最高分这个比例的条目就不要。
    // 用相对值而非绝对分，是因为 BM25 打分依赖语料规模（同一条命中
    // 在 N=2 里 1.22 分、N=101 里 6.02 分），写死绝对分必错。
    sparseMinRatio: 0.35,
    // 稀疏在 RRF 里的权重（仅当稠密那一路有结果时降权；稠密不可用时独占满权）
    sparseWeight: 0.5,
    // 关掉就退回纯稠密检索
    hybridSearch: true,
    // RRF 的 k（越大越平缓）
    rrfK: 60,
    dedupeThreshold: 0.86,
    // 记忆是「场景 + 事实」：每条另带 meaning（意义是否实际）/ confidence（置信度），
    // 加权出综合分。综合分**不当闸门**用，只决定召回时用什么口吻注入
    // （[确信]/[记得]/[模糊]），用来引导模型的思维链走向。详见 src/memory/score.js
    scoreWeights: { meaning: 0.4, scene: 0.25, confidence: 0.35 },
    // 低于此综合分的条目不入库；0 = 不靠分数拦截（默认），交给口吻分档去引导
    minStoreScore: 0,
    // 入库向量是否带上场景（记忆是场景关联的，气氛相近时也该被想起来）
    sceneInVector: true,
    // 相关记忆摆在哪：'tail'（默认）= 挂在本轮用户输入之后，保住 system+历史的
    // 前缀缓存；'system' = 退回旧的「插在人设之后」写法（每轮都变，会打掉缓存）
    memoryPlacement: 'tail',
    injectMemories: true,
    useSummary: true
  },
  // 向量模型：默认硅基流动（对话模型与向量模型可不同源）
  embedding: { provider: 'siliconflow', model: '' },
  // 重排模型（可选）：配了 model 才启用；不配就走融合后的顺序。
  // provider 留空 = 跟着向量模型那家走（重排模型通常在同一平台，如硅基流动的 BAAI/bge-reranker-v2-m3）
  rerank: { provider: '', model: '', topN: 20 },
  // 配置导出传输方式：file=JSON 原文件（默认，无损）/ image=图片载体（会被压缩）/ text=文本分段
  export: { mode: 'file' },
  // 角色扮演：对用户的称呼（{{user}} 占位符）
  roleplay: { userName: '用户' }
}

/** 环境变量覆盖（容器部署用，避免改动 config.json） */
export function applyEnvOverrides(cfg) {
  const env = process.env
  const out = structuredClone(cfg)
  if (env.BOT_AGENT) out.botAgent = env.BOT_AGENT
  if (env.CHANNEL_VERSION) out.channelVersion = env.CHANNEL_VERSION
  if (env.LOG_LEVEL) out.logLevel = env.LOG_LEVEL
  if (env.LOGIN_BASE_URL) out.loginBaseUrl = env.LOGIN_BASE_URL
  if (env.LOGIN_PAGE_PORT) out.loginPage.port = Number(env.LOGIN_PAGE_PORT)
  if (env.LOGIN_PAGE_HOST) out.loginPage.host = env.LOGIN_PAGE_HOST
  if (env.LOGIN_PAGE_ENABLED === '0') out.loginPage.enabled = false
  if (env.TYPING_ENABLED === '0') out.typing.enabled = false
  if (env.EXPORT_MODE) out.export.mode = env.EXPORT_MODE
  if (env.MAX_SEGMENTS_PER_REPLY) out.reply.maxSegmentsPerReply = Number(env.MAX_SEGMENTS_PER_REPLY)
  return out
}
