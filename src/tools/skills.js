/**
 * 工具技能：教模型“何时以及如何调用工具”。
 *
 * 角色卡可以描述表情包等表达习惯，但不写工具名、参数或调用格式。
 * 技能只负责说明如何调用实际可用的工具。
 */

export const TOOL_SKILLS = [
  {
    name: 'chat_stickers',
    summary: '准备发送聊天表情图时使用。',
    tools: ['send_file'],
    text:
      '角色决定发送表情图时，调用 send_file，参数使用 path 和 as:"image"。' +
      '只有工具结果明确说明已发出，才能视为发送成功。' +
      '不要把工具名、参数、文件名或尖括号标记写进正文。'
  },
  {
    name: 'stock_quote',
    summary: '对方询问股票最新价格或涨跌时使用。',
    tools: ['stock_quote'],
    text:
      '先调用 stock_quote，query 填股票名称或代码。' +
      '只用工具返回的数据回答，不预测涨跌，不给投资建议。' +
      '多个结果时先让对方确认代码。'
  }
]

export function enabledSkillNames(character) {
  const configured = character?.skills
  if (configured === undefined) return TOOL_SKILLS.map((skill) => skill.name)
  return (Array.isArray(configured) ? configured : []).map((name) => String(name || '').trim()).filter(Boolean)
}

export function availableToolSkills(availableTools, enabledSkills = null) {
  const names = new Set((availableTools || []).map((item) => String(item?.name || item || '')))
  const enabled = enabledSkills ? new Set(enabledSkills) : null
  return TOOL_SKILLS.filter((skill) => (!enabled || enabled.has(skill.name)) && skill.tools.every((name) => names.has(name)))
}

export function permittedToolNames(availableTools, enabledSkills = null) {
  const skills = availableToolSkills(availableTools, enabledSkills)
  const gated = new Set(TOOL_SKILLS.flatMap((skill) => skill.tools))
  const names = (availableTools || []).map((item) => String(item?.name || item || '')).filter(Boolean)
  return names.filter((name) => !gated.has(name) || skills.some((skill) => skill.tools.includes(name)))
}

export function renderToolSkillCatalog(availableTools, enabledSkills = null) {
  return availableToolSkills(availableTools, enabledSkills)
    .map((skill) => '- ' + skill.name + '：' + skill.summary)
    .join('\n')
}

export function renderToolSkill(name, availableTools, enabledSkills = null) {
  const skill = availableToolSkills(availableTools, enabledSkills).find((item) => item.name === String(name || '').trim())
  if (!skill) return ''
  return '<tool_skill name="' + skill.name + '">\n' + skill.text + '\n</tool_skill>'
}

export function renderToolSkills(availableTools) {
  const names = new Set((availableTools || []).map((item) => String(item?.name || item || '')))
  return TOOL_SKILLS
    .filter((skill) => skill.tools.every((name) => names.has(name)))
    .map((skill) => '<tool_skill name="' + skill.name + '">\n' + skill.text + '\n</tool_skill>')
    .join('\n\n')
}
