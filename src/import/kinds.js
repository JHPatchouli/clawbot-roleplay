/**
 * 导入文件类型识别（向后兼容主分支的数据格式）。
 */

/** 判断 JSON 结构属于哪种可导入类型 */
export function detectKind(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return Array.isArray(obj) ? 'unknown' : 'unknown'
  }
  // 主分支全量快照
  if (kind(obj, 'roleplay-snapshot') || (obj.app === 'demo' && obj.data && (obj.data.characters || obj.data.lorebook))) {
    return 'roleplay-snapshot'
  }
  // 主分支会话导出
  if (obj.format === 'app-session' || (obj.app === 'demo' && obj.session)) {
    return 'app-session'
  }
  // 设置 / Provider / 全量备份 / 会话（本项目导出格式）
  if (obj.kind === 'app-settings' && obj.config) return 'settings'
  if (obj.kind === 'app-providers' && obj.providers) return 'providers'
  if (obj.kind === 'app-backup') return 'backup'
  if (obj.kind === 'app-session' && Array.isArray(obj.messages)) return 'session'
  // Character Card V2 / V1
  const d = obj.data && typeof obj.data === 'object' ? obj.data : obj
  if (obj.spec === 'chara_card_v2' || (d.name && (d.first_mes !== undefined || d.description !== undefined || d.personality !== undefined))) {
    return 'character-card'
  }
  return 'unknown'
}

function kind(obj, k) {
  return obj.kind === k
}

/** 人类可读的类型名 */
export function kindLabel(k) {
  return {
    'roleplay-snapshot': '角色扮演全量快照（角色卡/世界书/记忆）',
    'character-card': '角色卡（Character Card）',
    'app-session': '会话记录（含思考链）',
    session: '会话记录（含思考链）',
    settings: '系统设置',
    providers: '模型服务商配置',
    backup: '全量备份（设置+Provider+角色数据+会话）',
    unknown: '无法识别的 JSON'
  }[k] || k
}
