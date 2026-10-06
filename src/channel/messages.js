/**
 * 消息编解码：iLink WeixinMessage <-> 内部标准结构。
 * 集中处理字段名，协议变动时只需改这里。
 */
import { randomUUID } from 'node:crypto'

export const MessageType = { USER: 1, BOT: 2 }
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 }
export const ItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12
}

/**
 * 将入站 WeixinMessage 归一化为内部结构。
 * @returns {{userId, messageId, clientId, contextToken, text, files, items, raw}}
 */
export function normalizeInbound(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : []
  const texts = items.filter((i) => i?.type === ItemType.TEXT && i.text_item).map((i) => i.text_item.text ?? '')
  const files = items.filter((i) => i?.type === ItemType.FILE && i.file_item).map((i) => i.file_item)
  const images = items
    .filter((i) => i?.type === ItemType.IMAGE && i.image_item)
    .map((i) => ({ media: i.image_item.media || {}, aeskey: i.image_item.aeskey || '', midSize: i.image_item.mid_size || 0 }))
  // 语音（item type 3）→ 归一化成与 images/videos 同构的形状。
  // voice_item 的字段名按多种常见形状识别，并保留 raw。诊断日志只记录字段名。
  const voices = items
    .filter((i) => i?.type === ItemType.VOICE && i.voice_item)
    .map((i) => {
      const v = i.voice_item || {}
      // media 的两种可能形状都认：① 规范形状 v.media；
      // ② **voice_item 自己就是**媒体引用（带 full_url / encrypt_query_param）——
      //    同时兼容 voice_item 本身就是媒体引用的结构。
      const media = v.media || v.media_ref || v.voice_media || (v.full_url || v.encrypt_query_param ? v : {})
      return {
        media,
        // 与图片/视频同理：hex 形式的 key 是 media 的兄弟字段
        aeskey: v.aeskey || i.aeskey || '',
        duration: v.duration ?? v.voice_len ?? v.len ?? 0,
        // 有的平台会自带识别结果；有就直接用，能省掉一次 ASR
        text: v.text || v.voice_text || v.speech_text || '',
        fields: Object.keys(v),
        itemKeys: Object.keys(i),
        raw: v
      }
    })
  const videos = items
    .filter((i) => i?.type === ItemType.VIDEO && i.video_item)
    .map((i) => ({
      media: i.video_item.media || {},
      // 与 image_item 同理：hex 形式的 key 是 media 的兄弟字段
      aeskey: i.video_item.aeskey || '',
      videoSize: i.video_item.video_size || i.video_item.mid_size || 0
    }))
  return {
    userId: msg?.from_user_id || '',
    messageId: msg?.message_id ?? null,
    clientId: msg?.client_id || '',
    contextToken: msg?.context_token || '',
    sessionId: msg?.session_id || '',
    text: texts.join('\n').trim(),
    files,
    images,
    voices,
    videos,
    items,
    raw: msg
  }
}

/**
 * 构造出站消息体（sendmessage 的 msg 字段）。
 * 协议字段名集中在此，变动时只需改这个文件。
 */
export function buildOutgoingItem({ toUserId, item, contextToken }) {
  return {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: `app-${randomUUID()}`,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken || '',
    item_list: [item]
  }
}

/** 文本 item */
export function buildTextItem(text) {
  return { type: ItemType.TEXT, text_item: { text } }
}

/** 构造出站文本消息体（sendmessage 的 msg 字段） */
export function buildOutgoingText({ toUserId, text, contextToken }) {
  return buildOutgoingItem({ toUserId, item: buildTextItem(text), contextToken })
}
