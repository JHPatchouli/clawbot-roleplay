# 命令说明

所有命令以 `/` 开头，在聊天中直接发送。多数命令不带参数时会返回当前状态和用法。

状态分为三类：

- **可用**：已接入正常流程，按命令配置后即可使用。
- **实验性**：代码已接入，但默认只作验证，不进入正常对话。
- **开发中**：命令或诊断可用，但对应能力尚未完成。

## 可用：基础

| 命令 | 作用 |
|---|---|
| `/help` | 查看帮助 |
| `/menu` | 打开主菜单 |
| `/ping` | 测试连通 |
| `/status` | 查看运行状态 |
| `/dashboard` | 查看配置、会话和角色总览 |
| `/whoami` | 查看当前用户 ID |
| `/cancel` | 取消当前操作 |
| `/usage` | 查看 token 用量和缓存命中率 |
| `/pending` | 查看发送失败后的待发队列；`/pending retry` 立即补发 |

## 可用：模型

| 命令 | 作用 |
|---|---|
| `/provider` | 查看或切换模型服务商 |
| `/key set <key>` | 设置当前服务商的 API Key |
| `/key set <provider> <key>` | 为指定服务商设置 Key |
| `/model` | 列出对话模型 |
| `/model use <序号或名称>` | 切换模型 |
| `/thinking` | 查看思考量 |
| `/thinking budget <n>` | 设置思考预算 |
| `/balance` | 查询支持余额接口的账户余额 |
| `/embed` | 配置向量模型 |
| `/max` | 查看回复、记忆抽取和总结的生成上限 |
| `/max reply\|extract\|summary <n\|max>` | 分别设置上限 |

## 可用：会话与上下文

| 命令 | 作用 |
|---|---|
| `/session` | 列出会话 |
| `/session new [名称]` | 新建会话 |
| `/session use <序号>` | 切换会话 |
| `/session rename <名称>` | 重命名当前会话 |
| `/session del <序号>` | 删除会话 |
| `/context` | 查看当前上下文 |
| `/reset` | 清空当前上下文，不影响配置 |
| `/cot [轮数\|all]` | 查看思维链和工具调用 |
| `/summary now` | 生成当前对话总结 |
| `/summary` | 查看总结；`del <序号>` 删除，`clear` 清空 |

## 可用：角色扮演

| 命令 | 作用 |
|---|---|
| `/rp` | 查看角色卡、世界书、称呼和提示词总览 |
| `/char` | 列出角色卡 |
| `/char use <序号>` | 使用角色卡 |
| `/char show <序号>` | 查看角色卡 |
| `/char export <序号>` | 导出角色卡 |
| `/char clone <序号>` | 复制角色卡 |
| `/char del <序号>` | 删除角色卡 |
| `/char claim` | 认领没有归属的角色卡 |
| `/user <称呼>` | 设置全局称呼 |
| `/user session <称呼>` | 只在当前会话使用该称呼 |
| `/user reset` | 当前会话恢复全局称呼 |
| `/lore` | 列出世界书；`export` 导出，`del <序号>` 删除 |
| `/prompt` | 查看提示词 |
| `/prompt <key>` | 查看某一段提示词 |
| `/prompt char` | 查看当前角色实际组装出的提示词 |

角色卡和世界书通过导入 JSON 添加。

## 可用：记忆

| 命令 | 作用 |
|---|---|
| `/mem` | 查看记忆状态 |
| `/mem list` | 列出当前会话记忆 |
| `/mem search <内容>` | 搜索记忆 |
| `/mem add <内容>` | 手动添加记忆 |
| `/mem extract` | 从最近对话抽取记忆 |
| `/mem backfill` | 回补历史对话中的记忆 |
| `/mem global <序号\|all>` | 将会话记忆提升为全局可见 |
| `/mem del <序号>` | 删除记忆 |
| `/mem clear` | 清空当前范围的记忆 |
| `/mem vector` | 查看向量索引 |
| `/mem orphan` | 查看失去归属的记忆 |
| `/mem reembed` | 重新生成向量 |
| `/mem prune` | 清理低价值记忆 |

## 可用：感知

| 命令 | 作用 |
|---|---|
| `/perc` | 查看时间和天气状态 |
| `/perc on\|off` | 开关全部感知 |
| `/perc preview` | 查看本轮实际注入的内容 |
| `/perc now`、`/now` | 查看当前时间 |
| `/perc time on\|off` | 开关时间感知 |
| `/perc tz <IANA 时区>` | 设置时区，例如 `Asia/Shanghai` |
| `/perc gap <1-72>` | 设置场景切换提醒阈值，单位为小时 |
| `/perc weather on\|off` | 开关天气 |
| `/perc weather provider <名称>` | 切换天气源 |
| `/perc weather ttl <分钟>` | 设置缓存时间 |
| `/perc weather key <密钥>` | 设置天气源密钥；`clear` 清除 |
| `/perc city` | 列出地点 |
| `/perc city <备注> <纬度>,<经度>` | 添加地点，最多 8 处 |
| `/perc city del <序号>` | 删除地点 |
| `/perc city rename <序号> <备注>` | 修改备注 |
| `/perc city clear` | 清空地点 |

天气不会按服务器 IP 自动定位。经纬度写反且可以明确判断时会自动调换；两个数值都合法时保持输入顺序。中文地名只显示候选，不会自动采用。

## 可用：回复、导入导出、工具和主动开口

| 命令 | 作用 |
|---|---|
| `/reply on\|off` | 开关分段发送 |
| `/reply delay <毫秒>` | 设置分段间隔 |
| `/reply merge <毫秒>` | 设置连续消息合并窗口；`0` 为关闭 |
| `/reply tokens <n>` | 设置回复生成上限 |
| `/import confirm` | 合并导入刚收到的文件 |
| `/import replace` | 覆盖导入 |
| `/import cancel` | 取消导入 |
| `/export [roleplay\|settings\|providers\|all]` | 导出 JSON |
| `/export providers full` | 导出服务商配置并包含密钥 |
| `/exportmode file\|text\|image` | 设置导出方式，建议使用 `file` |
| `/tools` | 查看工具状态 |
| `/tools on\|off` | 开关工具 |
| `/tools test` | 测试工具 |
| `/tools web provider <名称>` | 设置联网搜索源 |
| `/tools web key <密钥>` | 设置搜索密钥 |
| `/tools web url <地址>` | 设置自建搜索地址 |
| `/agent` | 查看任务委托状态 |
| `/agent on\|off` | 开关委托 |
| `/agent key <密钥>` | 设置委托模型密钥；`clear` 改用对话模型密钥 |
| `/agent max <1-30>` | 设置最大往返次数 |
| `/agent timeout <10-900>` | 设置超时秒数 |
| `/agent run <任务>` | 委托一次任务 |
| `/agent log` | 查看委托日志 |
| `/proactive` | 查看主动开口状态 |
| `/proactive on\|off` | 开关主动开口 |
| `/proactive gap <最短>-<最长>` | 设置随机间隔，单位为分钟 |
| `/proactive silence <分钟>` | 设置最短静默时间 |
| `/proactive cap <0-50>` | 设置每日上限；`0` 为不限 |
| `/proactive quiet <起>-<止>` | 设置静默小时段 |
| `/proactive now` | 立即尝试一次 |

## 实验性：语音转文字

语音识别已经接入，但默认是 `probe` 验证模式：只回传识别文字，不写入历史，也不进入模型对话。确认结果稳定后，再用 `/asr mode chat` 切换到正常聊天。

| 命令 | 作用 |
|---|---|
| `/asr` | 查看状态 |
| `/asr on\|off` | 开关识别 |
| `/asr mode probe\|chat` | 切换验证模式或正常聊天模式 |
| `/asr model <模型名>` | 切换识别模型 |
| `/asr diar on\|off` | 开关说话人区分 |
| `/asr diar notify on\|off` | 是否把「有多人在说」写入对话 |
| `/asr last` | 查看最近一次识别 |
| `/asr test` | 测试识别配置 |

## 开发中

这些能力尚未完成。相关命令只用于诊断或查看状态，不代表功能已经可用。

| 能力 | 当前状态 |
|---|---|
| 文字转语音 | 未接入。需要语音合成服务和出站语音消息格式。 |
| 视频理解 | 未接入。收到的视频目前只保留原文件，不能理解画面。 |
| 链接理解 | 未接入。不能自动打开并理解视频或网页链接。 |
| `/diag` | 诊断命令：发送测试图片和测试文件。 |
| `/resendimg` | 诊断命令：原样回发最近收到的图片。 |
| `/diagvideo [video_size\|len\|mid_size\|file]` | 诊断命令：用不同字段回发视频，用于排查通道压缩。 |
