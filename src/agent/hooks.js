/**
 * 委托出去的「干活 agent」的安全闸门（跑在 runner 子进程里，由 SDK 回调）。
 *
 * 为什么需要这一层：
 *   委托出去的 agent 有 Bash——它能跑任何命令。它拿到的任务是**模型写的**，
 *   而任务内容可能来自网页/对方发的文本（提示注入的经典入口）。
 *   单靠「用 nobody 身份跑」只能挡住文件，挡不住**网络**：
 *   容器里能摸到云厂商元数据地址（100.100.100.200 / 169.254.169.254），
 *   那上面可能挂着实例的临时凭据。我们自己工具的 SSRF 防护
 *   （tools/web.js 的 isPrivateIp）管不到这条 Bash 出口，所以这里补一道。
 *
 * 定位：这是**启发式拦截**，不是沙箱。真正的边界是「nobody 身份 + data 目录 700」，
 *   这里只是把最常见的那条外泄路径（内网地址）堵上，并在日志里留痕。
 */

/** 明显指向内网/元数据服务的字样（按**文本**匹配，命令里出现就拒） */
const DENY_PATTERNS = [
  // 云元数据
  { re: /169\.254\.169\.254/i, why: '云实例元数据地址' },
  { re: /100\.100\.100\.200/i, why: '云主机元数据地址' },
  { re: /\bmetadata\.(google|aws)\b/i, why: '云元数据域名' },
  { re: /meta-data|\/latest\/meta/i, why: '元数据路径' },
  // 环回与私网字面量（内网服务不该被脚本碰；真要访问公网不会有这些）
  // ⚠️ 前导字符类必须带上 `/` 与 `:`：测试抓到的漏网就是 `curl http://127.0.0.1:8080/`
  //    ——`127.0.0.1` 前面是 `http://` 里的那个 `/`，不在 `[\s"'=@]` 里，于是漏放。
  { re: /(^|[\s"'=@/:])(127\.0\.0\.1|localhost|0\.0\.0\.0)([\s:/"'?#]|$)/i, why: '环回地址' },
  { re: /(^|[\s"'=@/:])10\.\d{1,3}\.\d{1,3}\.\d{1,3}/, why: '私网地址 10.x' },
  { re: /(^|[\s"'=@/:])192\.168\.\d{1,3}\.\d{1,3}/, why: '私网地址 192.168.x' },
  { re: /(^|[\s"'=@/:])172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/, why: '私网地址 172.16-31.x' },
  // 明显的提权/破坏行径（我们没有任何需要它们的场景）
  { re: /\bsudo\b|\bsu\s+-/i, why: '提权命令' },
  { re: /\brm\s+(-[a-z]*\s+)*\/(?!tmp\/|app\/data-agent)/i, why: '删除系统目录' },
  { re: /\bchmod\s+777\s+\//i, why: '把系统目录改成全员可写' },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\//i, why: '破坏文件系统' }
]

/**
 * 判断一条 Bash 命令能不能跑（纯函数，便于自检直接调）。
 * @returns {{allow:true}|{allow:false, reason:string}}
 */
export function judgeBashCommand(command) {
  const cmd = String(command || '')
  if (!cmd.trim()) return { allow: true }
  for (const p of DENY_PATTERNS) {
    if (p.re.test(cmd)) {
      return { allow: false, reason: `命中禁止模式（${p.why}）` }
    }
  }
  return { allow: true }
}

/** 从 hook 的入参里取命令文本（SDK 的形状在不同版本里略有差异，都兜一下） */
export function extractCommand(input) {
  const ti = (input && input.tool_input) || {}
  return String(ti.command ?? ti.cmd ?? '')
}

/**
 * 构造 SDK 的 hooks。
 *
 * 返回**两种**拒绝写法（decision:block 与 hookSpecificOutput.permissionDecision），
 * 是因为 SDK 各版本读的字段不一样——多写一个不会有副作用，少写就可能静默放行。
 */
export function makeHooks({ logger } = {}) {
  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input) => {
            const cmd = extractCommand(input)
            const verdict = judgeBashCommand(cmd)
            if (verdict.allow) return {}
            logger?.warn?.('[delegate] 拦截 Bash 命令（' + verdict.reason + '）：' + cmd.slice(0, 120))
            return {
              decision: 'block',
              reason: `这条命令被安全策略拒绝：${verdict.reason}。换一种做法，或直接说明做不到。`,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `安全策略拒绝：${verdict.reason}`
              }
            }
          }
        ]
      }
    ]
  }
}
