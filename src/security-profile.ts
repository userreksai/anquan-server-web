import type { ComponentReport, SecurityComponent } from './types'

export interface SecurityProfile {
  enabled: boolean
  install_missing: boolean
  poll_interval_seconds: number
  status_interval_seconds: number
  max_queue_events: number
  auditd: { enabled: boolean; audit_exec: boolean; watch_paths: string[]; rules: string[] }
  native_fim: { enabled: boolean; paths: string[]; poll_interval_seconds: number; report_changes: boolean; capture_created_content: boolean; max_diff_bytes: number }
  sudo: { enabled: boolean; io_logging: boolean; upload_io: boolean; max_session_bytes: number; restrict_users: string[]; grants: { user: string; run_as: string; commands: string[]; nopasswd: boolean }[] }
  ssh_auth: { enabled: boolean; poll_interval_seconds: number; initial_lookback_seconds: number; alert_threshold: number; window_seconds: number }
  tetragon: { enabled: boolean; version: string; download_url: string; sha256: string; config: string; tracing_policy: string }
  policies: {
    mode: 'audit' | 'enforce'
    ssh: { enabled: boolean; password_authentication: string; permit_root_login: string; allow_users: string[]; allow_sources: string[]; disable_forwarding: boolean; strong_crypto: boolean }
    sysctl: Record<string, string>
    session_timeout_seconds: number
    disable_ctrl_alt_del: boolean
    grub: { enabled: boolean; password_hash: string; protect_single_user: boolean }
  }
}

export const criticalPaths = ['/etc/passwd', '/etc/group', '/etc/shadow', '/etc/ssh', '/etc/sudoers', '/etc/sudoers.d', '/etc/crontab', '/etc/cron.d']

export function defaultSecurityProfile(): SecurityProfile {
  return {
    enabled: true, install_missing: true, poll_interval_seconds: 2, status_interval_seconds: 30, max_queue_events: 10000,
    auditd: { enabled: true, audit_exec: true, watch_paths: [...criticalPaths], rules: [] },
    native_fim: { enabled: true, paths: [...criticalPaths], poll_interval_seconds: 30, report_changes: false, capture_created_content: true, max_diff_bytes: 8192 },
    sudo: { enabled: true, io_logging: true, upload_io: false, max_session_bytes: 20971520, restrict_users: [], grants: [] },
    ssh_auth: { enabled: true, poll_interval_seconds: 5, initial_lookback_seconds: 300, alert_threshold: 5, window_seconds: 300 },
    tetragon: { enabled: false, version: 'v1.7.1', download_url: '', sha256: '', config: '', tracing_policy: '' },
    policies: {
      mode: 'audit',
      ssh: { enabled: false, password_authentication: 'no', permit_root_login: 'prohibit-password', allow_users: [], allow_sources: [], disable_forwarding: false, strong_crypto: false },
      sysctl: {}, session_timeout_seconds: 0, disable_ctrl_alt_del: false,
      grub: { enabled: false, password_hash: '', protect_single_user: false },
    },
  }
}

// The server validates the schema and merges into the original YAML document.
// Preserve advanced fields when an existing profile is loaded into the form.
export function mergeProfile<T>(defaults: T, existing: unknown): T {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return defaults
  const result = { ...defaults } as Record<string, unknown>
  for (const [key, value] of Object.entries(existing)) {
    const base = result[key]
    result[key] = base && value && typeof base === 'object' && typeof value === 'object' && !Array.isArray(base) && !Array.isArray(value)
      ? mergeProfile(base, value) : value
  }
  return result as T
}

export function lines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

export function parseSysctl(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of lines(value)) {
    if (line.startsWith('#')) continue
    const position = line.indexOf('=')
    const key = line.slice(0, position).trim()
    const setting = line.slice(position + 1).trim()
    if (position < 1 || !/^[a-zA-Z0-9_.]+$/.test(key) || !setting) throw new Error(`内核参数格式有误：${line}。请使用 key = value，每行一项。`)
    if (Object.hasOwn(result, key)) throw new Error(`内核参数重复：${key}`)
    result[key] = setting
  }
  return result
}

export const kernelPolicies = [
  { key: 'kernel.dmesg_restrict', value: '1', label: '限制普通用户读取内核日志', description: '限制未授权用户读取 dmesg。' },
  { key: 'kernel.kptr_restrict', value: '2', label: '隐藏内核指针地址', description: '将内核指针显示限制为更严格的级别。' },
  { key: 'net.ipv4.conf.all.rp_filter', value: '1', label: '启用严格反向路径检查', description: '严格检查 IPv4 来源路由；多网卡、VPN、非对称路由和容器网络可能断连，请按节点用途选择。' },
  { key: 'net.ipv4.tcp_syncookies', value: '1', label: '启用 TCP SYN cookies', description: '在 SYN 队列溢出时使用 SYN cookies。' },
] as const

export function advancedSysctl(values: Record<string, string>): string {
  return Object.entries(values).filter(([key]) => !kernelPolicies.some(policy => policy.key === key)).map(([key, value]) => `${key} = ${value}`).join('\n')
}

export function setKernelPolicy(values: Record<string, string>, key: string, enabled: boolean): Record<string, string> {
  const policy = kernelPolicies.find(policy => policy.key === key)
  if (!policy) throw new Error('未知内核策略')
  const next = { ...values }
  if (enabled) next[key] = policy.value
  else delete next[key]
  return next
}

export function mergeAdvancedSysctl(values: Record<string, string>, text: string): Record<string, string> {
  const advanced = parseSysctl(text)
  for (const policy of kernelPolicies) {
    if (Object.hasOwn(advanced, policy.key)) throw new Error(`${policy.key} 请使用对应独立开关设置；已有自定义值会原样保留。`)
    if (Object.hasOwn(values, policy.key)) advanced[policy.key] = values[policy.key]!
  }
  return advanced
}

export function policyMode(component: SecurityComponent): string {
  if (component.policy_mode === 'audit' || component.policy_mode === 'enforce') return component.policy_mode
  if (!component.policy_mode && (component.state === 'audit' || component.state === 'audit_drift')) return 'audit'
  return ''
}

export function policyState(component: SecurityComponent): string {
  if (!component.enabled || component.state === 'disabled') return '已禁用'
  if (['error', 'failed', 'config_failed', 'install_failed'].includes(component.state) || component.error) return policyMode(component) === 'audit' ? '策略检查失败' : '策略执行或检查失败'
  if (component.state === 'audit_drift' || component.state === 'drift' && policyMode(component) === 'audit') return '检查未达标（未执行加固）'
  if (component.state === 'no_policies') return '未选择加固策略'
  if (component.state === 'compliant') return '加固检查已达标'
  if (component.state === 'audit') return component.checks?.length && component.checks.every(check => check.compliant === true && !check.error) ? '仅检查（已达标）' : '仅检查'
  if (component.state === 'drift') return policyMode(component) === 'enforce' ? '加固结果偏离目标' : '策略偏离目标（模式未上报）'
  if (component.state === 'applied' || component.state === 'configured') return '配置已写入（旧版未上报核验结论）'
  return componentState(component.state)
}

export function policyCheckName(setting: unknown): string {
  const names: Record<string, string> = {
    'ssh.password_authentication': 'SSH 密码认证', 'ssh.kbd_interactive_authentication': 'SSH 交互式认证',
    'ssh.permit_root_login': 'SSH root 登录', 'ssh.allow_users': 'SSH 允许用户', 'ssh.allow_sources': 'SSH 允许来源',
    'ssh.disable_forwarding': 'SSH 转发限制', 'ssh.strong_crypto': 'SSH 强密码算法',
    'ssh.passwordauthentication': 'SSH 密码认证', 'ssh.kbdinteractiveauthentication': 'SSH 交互式认证',
    'ssh.permitrootlogin': 'SSH root 登录', 'ssh.allowusers': 'SSH 允许用户',
    'ssh.disableforwarding': 'SSH 全部转发限制', 'ssh.allowtcpforwarding': 'SSH TCP 转发',
    'ssh.allowagentforwarding': 'SSH 认证代理转发', 'ssh.allowstreamlocalforwarding': 'SSH 本地套接字转发',
    'ssh.x11forwarding': 'SSH X11 图形转发', 'ssh.permittunnel': 'SSH 网络隧道',
    'ssh.permitopen': 'SSH 允许转发目标', 'ssh.permitlisten': 'SSH 允许监听地址',
    'ssh.ciphers': 'SSH 加密算法', 'ssh.macs': 'SSH 完整性算法', 'ssh.kexalgorithms': 'SSH 密钥交换算法',
    'ssh.hostkeyalgorithms': 'SSH 主机密钥算法', 'ssh.pubkeyacceptedalgorithms': 'SSH 用户公钥算法',
    'ssh.effective_policy': 'SSH 实际生效策略与连接条件', 'ssh.supported_algorithms': 'SSH 支持的安全算法',
    'sudo.restrict_users': 'sudo 账户权限收紧', 'grub.authentication': 'GRUB 启动认证',
    'session_timeout_seconds': '交互 Shell 空闲超时', 'disable_ctrl_alt_del': 'Ctrl+Alt+Del 重启限制',
    'ctrl_alt_del_burst_action': '连续按 Ctrl+Alt+Del 的重启行为',
    'grub.password': 'GRUB 密码保护', 'grub.protect_single_user': '单用户与救援启动认证',
  }
  const key = typeof setting === 'string' ? setting : ''
  if (names[key]) return names[key]!
  if (key.startsWith('sysctl.')) return kernelPolicies.find(policy => policy.key === key.slice(7))?.label || `内核参数 ${key.slice(7)}`
  if (key.startsWith('sudo.grant.')) return `sudo 授权：${key.slice(11)}`
  if (key.startsWith('sudo.restrict.')) return `sudo 权限收紧：${key.slice(14)}`
  return key || '未命名检查'
}

export const componentNames: Record<string, string> = { auditd: 'Linux Audit', native_fim: 'Agent 文件监控', tetragon: 'Tetragon', sudo: 'sudo 审计', ssh_auth: 'SSH 认证监控', task_wrapper: '任务执行记录', policies: '系统加固策略', ssh: 'SSH 策略', sysctl: '内核参数', grub: '启动保护' }

export function componentReportStale(report: Pick<ComponentReport, 'received_at' | 'data'>, now = Date.now()): boolean {
  const interval = report.data.snapshot_interval_seconds
  const changesOnly = report.data.status_reporting === 'changes_only'
    && typeof interval === 'number' && Number.isInteger(interval) && interval > 0 && interval <= 86400
  const timeout = changesOnly ? Math.max(120_000, interval * 2000) : 120_000
  return now - new Date(report.received_at).valueOf() > timeout
}

export function componentState(state: string): string {
  return ({ running: '运行中', ready: '就绪', applied: '已应用', configured: '已配置', disabled: '已禁用', installing: '安装中', pending: '等待应用', not_installed: '未安装', missing: '未安装', install_failed: '安装失败', config_failed: '配置失败', failed: '失败', error: '异常', drift: '配置偏离目标', audit: '仅检查', audit_drift: '检查未达标（未执行加固）', compliant: '检查已达标', no_policies: '未选择策略', audit_only: '仅检查', unsupported: '环境不支持', degraded: '部分异常', stopped: '未运行', healthy: '正常' } as Record<string, string>)[state] || state || '未知状态'
}

export function componentTruncation(component: { omitted_checks?: number; checks?: unknown }): string {
  const notes: string[] = []
  if (typeof component.omitted_checks === 'number' && component.omitted_checks > 0) notes.push(`已省略 ${component.omitted_checks} 项检查`)
  if (Array.isArray(component.checks) && component.checks.some(check => check && typeof check === 'object' && check.truncated === true)) notes.push('部分检查长文本已截断')
  return notes.join('；')
}
