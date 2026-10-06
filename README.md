<div align="center">

# ClawBot 角色扮演后端框架

ClawBot WeChat roleplay backend for character cards, long-term memory, tool calling, and time and weather perception.

基于 ClawBot 微信接口的可扩展角色扮演后端，支持角色卡、长期记忆、工具调用、时间与天气感知。

角色卡 · 长期记忆 · 工具调用 · 时间与天气感知 · 主动开口

<br>

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node.js-20%2B-339933.svg)](package.json)
[![Documentation](https://img.shields.io/badge/docs-wiki-6f42c1.svg)](https://github.com/JHPatchouli/clawbot-roleplay/wiki)

<br>

[命令说明](https://github.com/JHPatchouli/clawbot-roleplay/wiki/命令说明) ·
[使用示例](https://github.com/JHPatchouli/clawbot-roleplay/wiki/使用示例) ·
[二次开发](https://github.com/JHPatchouli/clawbot-roleplay/wiki/二次开发)

</div>

---

这是一个用于学习和二次开发的角色扮演后端。实现过程中借鉴了 AstrBot 等成熟框架在机器人扩展、上下文组织和插件化方面的做法，并把这些思路收敛到 ClawBot 通道与长记忆场景中。

项目不包含管理前端。模型、角色、记忆、感知和调度都通过聊天命令配置，配置保存为 JSON。这样运行依赖少，也便于直接阅读和修改源码。

角色保持独立的人设、会话和记忆；模型可以调用工具，系统则在每轮对话中提供时间和天气。感知、工具与命令分别注册，新增一种能力不需要改写消息通道或模型调用流程。

## 差异

角色关系不从每轮对话重新开始。长期记忆保留经历、约定和变化，并区分当前会话与全局范围；角色也可以按现实时间主动开口。时间和天气作为现实上下文注入，位置由使用者明确配置，不从服务器 IP 推断。

当前交互仍以文字为主，语音识别处于实验阶段。后续方向是完成语音输入到语音回复，并把图片、视频、语音和链接纳入同一轮对话。

## 方向

| 阶段 | 内容 | 状态 |
|---|---|---|
| 当前 | 文字对话、长期记忆、工具调用、时间与多地点天气 | 可用 |
| 实验 | 语音输入转文字，默认识别后回传，不进入对话 | 实验性 |
| 下一步 | 文字回复转为语音并发送 | 开发中 |
| 后续 | 图片、视频、语音和链接在同一轮中理解与回复 | 开发中 |

<table>
<tr>
<td width="50%">

### 角色与记忆

角色卡、世界书、称呼、会话历史和长期记忆分开存储。记忆同时支持关键词与向量检索，并可以保持在当前会话或提升为全局记忆。

</td>
<td width="50%">

### 扩展点

感知源、模型工具和聊天命令都有独立的注册入口。每轮变化的信息附加在用户输入之后，不进入系统提示词，从而保留前缀缓存。

</td>
</tr>
<tr>
<td width="50%">

### 对话运行

回复可以分段发送，发送失败后进入补发队列。框架提供主动开口调度、配置导入导出，以及 token 用量和缓存命中统计。

</td>
<td width="50%">

### 现实上下文

每轮注入当前时间和多地点天气。天气位置必须明确配置，不使用服务器 IP 推断；地点备注会随天气信息一起提供给角色。

</td>
</tr>
</table>

## 技术栈与实现

| 层次 | 实现 |
|---|---|
| 运行时 | Node.js 20+，原生 ES Modules，不依赖 Web 框架 |
| 通道 | ClawBot / iLink 长轮询；媒体分块、加密传输和分段发送 |
| 模型 | OpenAI 兼容 HTTP 接口；服务商、模型和密钥可切换 |
| 存储 | `data/` 中的 JSON 集合，配置、会话、记忆与向量分开保存 |
| 检索 | 关键词检索与进程内余弦向量检索融合 |
| 上下文 | 稳定人设放在系统提示词；每轮变化的信息追加到用户输入后 |
| 扩展 | 命令、感知源和模型工具分别注册，由 `src/app.js` 组装 |
| 语音 | `silk-wasm` 解码 SILK，再调用外部语音识别接口 |
| 部署 | Docker，基于 `node:20-bookworm-slim`；`tini` 管理进程 |

## 能力状态

| 模块 | 内容 | 状态 |
|---|---|---|
| 角色 | 多租户会话、角色卡、世界书、称呼 | 可用 |
| 记忆 | 长期记忆、关键词与向量检索 | 可用 |
| 模型 | 服务商切换、工具调用、任务委托 | 可用 |
| 感知 | 当前时间、多地点天气、昨天与未来几天 | 可用 |
| 调度 | 主动开口、分段回复、失败补发 | 可用 |
| 语音 | 语音转文字 | 实验性，默认仅回传识别结果 |
| 感知扩展 | 文字转语音、视频理解、链接理解 | 开发中 |

## 开始

```bash
npm install
npm start
node src/cli/selftest.js
```

首次启动进入通道登录流程。凭据保存在 `data/`，重启后继续使用。部署步骤见 [deploy/vps-setup.sh](deploy/vps-setup.sh)。

## 文档

| 文档 | 内容 |
|---|---|
| [命令说明](https://github.com/JHPatchouli/clawbot-roleplay/wiki/命令说明) | 全部命令、参数和功能状态 |
| [使用示例](https://github.com/JHPatchouli/clawbot-roleplay/wiki/使用示例) | 从接入模型到天气与语音的配置顺序 |
| [二次开发](https://github.com/JHPatchouli/clawbot-roleplay/wiki/二次开发) | 新增命令、感知、工具和测试的入口 |
| [导入格式](https://github.com/JHPatchouli/clawbot-roleplay/wiki/导入格式) | 角色卡、世界书、记忆、会话和配置 JSON |

---

<div align="center">

# ClawBot Roleplay Backend Framework

An extensible roleplay backend for the ClawBot WeChat interface.

Character cards · Long-term memory · Tools · Time and weather · Proactive messages

<br>

[Commands](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Commands) ·
[Examples](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Examples) ·
[Development](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Development)

This is a roleplay backend intended for learning and further development. Its design draws on mature frameworks such as AstrBot, particularly their approaches to bot extensibility, context organization, and modular features, and adapts those ideas to the ClawBot channel and long-term memory.

The project has no administration frontend. Models, characters, memories, perception, and scheduling are configured through chat commands, with settings stored as JSON. This keeps the runtime small and makes the source code straightforward to read and modify.

</div>

---

Characters keep separate personas, sessions, and memories. The model can call tools, while the system supplies time and weather on each turn. Perception, tools, and commands are registered separately, so adding a capability does not require rewriting the channel or the model loop.

## What is different

A character relationship continues across turns. Long-term memory keeps experiences, agreements, and changes, with separate session and global scope, and a character can start a message based on real-world time. Time and weather enter each turn as real context. Locations are configured explicitly and are not inferred from the server IP.

The current interaction is still text-first, with experimental speech recognition. The direction is speech input followed by spoken replies, then images, video, audio, and links handled in the same turn.

## Direction

| Stage | Scope | Status |
|---|---|---|
| Now | Text chat, long-term memory, tools, time, and multi-location weather | Stable |
| Experimental | Speech input to text; transcripts are returned for verification and do not enter chat | Experimental |
| Next | Convert text replies to speech and send them | In development |
| Later | Understand and answer with images, video, audio, and links in one turn | In development |

<table>
<tr>
<td width="50%">

### Character and memory

Character cards, lore, forms of address, history, and long-term memories are stored separately. Retrieval combines keywords and vectors, with either session or global scope.

</td>
<td width="50%">

### Extension points

Perception sources, model tools, and chat commands each have a registration point. Turn-specific information is appended to the user input instead of the system prompt, preserving prefix caching.

</td>
</tr>
<tr>
<td width="50%">

### Conversation runtime

Replies can be segmented, and failed sends enter a retry queue. The framework also provides proactive-message scheduling, import and export, and token and cache metrics.

</td>
<td width="50%">

### Real-world context

Each turn includes the current time and weather for configured places. Locations are explicit rather than inferred from the server IP, and each place label is shown with its weather.

</td>
</tr>
</table>

## Stack and implementation

| Layer | Implementation |
|---|---|
| Runtime | Node.js 20+ with native ES Modules and no web framework |
| Channel | ClawBot / iLink long polling, with chunked encrypted media and segmented replies |
| Models | OpenAI-compatible HTTP APIs; providers, models, and keys are switchable |
| Storage | JSON collections in `data/` for configuration, sessions, memories, and vectors |
| Retrieval | Keyword search fused with in-process cosine vector search |
| Context | Stable persona text stays in the system prompt; turn-specific data follows the user input |
| Extensions | Commands, perception sources, and model tools register separately and are composed by `src/app.js` |
| Speech | SILK decoding through `silk-wasm`, followed by an external recognition API |
| Deployment | Docker image based on `node:20-bookworm-slim`, with `tini` as the process supervisor |

## Status

| Module | Includes | Status |
|---|---|---|
| Character | Multi-user sessions, cards, lore, forms of address | Stable |
| Memory | Long-term memory, keyword and vector retrieval | Stable |
| Model | Provider switching, tool calls, task delegation | Stable |
| Perception | Current time, multi-location weather, previous day and forecast | Stable |
| Runtime | Proactive messages, segmented replies, retries | Stable |
| Speech | Speech to text | Experimental; verification output only by default |
| Planned perception | Text to speech, video understanding, link understanding | In development |

## Start

```bash
npm install
npm start
node src/cli/selftest.js
```

The first launch starts the channel login flow. Credentials remain in `data/` and are reused after a restart. See [deploy/vps-setup.sh](deploy/vps-setup.sh) for deployment.

## Documentation

| Document | Contents |
|---|---|
| [Commands](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Commands) | All commands, arguments, and feature status |
| [Examples](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Examples) | Setup flow from model access through weather and speech |
| [Import formats](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Import-Formats) | JSON for cards, lore, memories, sessions, and configuration |
| [Development](https://github.com/JHPatchouli/clawbot-roleplay/wiki/Development) | Extension points for commands, perception, tools, and tests |

## 许可 / License

[AGPL-3.0](LICENSE)。可以学习、修改和使用；修改后再分发或通过网络提供服务时，必须以同样协议公开对应源码。

You may study, modify, and use this project. Distributing a modified version or serving it over a network requires releasing the corresponding source under the same license.
