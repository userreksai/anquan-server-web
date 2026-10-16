export interface SecurityProfile {
  enabled: boolean
  install_missing: boolean
  poll_interval_seconds: number
  status_interval_seconds: number
  max_queue_events: number
  auditd: { enabled: boolean; audit_exec: boolean; watch_paths: string[]; rules: string[] }
  native_fim: { enabled: boolean; paths: string[]; poll_interval_seconds: number; report_changes: boolean; max_diff_bytes: number }
  sudo: { enabled: boolean; io_logging: boolean; upload_io: boolean; max_session_bytes: number; grants: { user: string; run_as: string; commands: string[]; nopasswd: boolean }[] }
  ssh_auth: { enabled: boolean; poll_interval_seconds: number; initial_lookback_seconds: number; alert_threshold: number; window_seconds: number }
  tetragon: { enabled: boolean; version: string; download_url: string; sha256: string; config: string; tracing_policy: string }
  policies: {
    mode: 'audit' | 'enforce'
    ssh: { enabled: boolean; password_authentication: string; permit_root_login: string; allow_users: string[]; allow_sources: string[] }
    sysctl: Record<string, string>
    session_timeout_seconds: number
    disable_ctrl_alt_del: boolean
    grub: { enabled: boolean; password_hash: string }
  }
}

export const criticalPaths = ['/etc/passwd', '/etc/group', '/etc/shadow', '/etc/ssh', '/etc/sudoers', '/etc/sudoers.d', '/etc/crontab', '/etc/cron.d']

export function defaultSecurityProfile(): SecurityProfile {
  return {
    enabled: true, install_missing: true, poll_interval_seconds: 2, status_interval_seconds: 30, max_queue_events: 10000,
    auditd: { enabled: true, audit_exec: true, watch_paths: [...criticalPaths], rules: [] },
    native_fim: { enabled: true, paths: [...criticalPaths], poll_interval_seconds: 30, report_changes: false, max_diff_bytes: 8192 },
    sudo: { enabled: true, io_logging: true, upload_io: false, max_session_bytes: 20971520, grants: [] },
    ssh_auth: { enabled: true, poll_interval_seconds: 5, initial_lookback_seconds: 300, alert_threshold: 5, window_seconds: 300 },
    tetragon: { enabled: false, version: 'v1.7.1', download_url: '', sha256: '', config: '', tracing_policy: '' },
    policies: {
      mode: 'audit',
      ssh: { enabled: false, password_authentication: 'no', permit_root_login: 'prohibit-password', allow_users: [], allow_sources: [] },
      sysctl: {}, session_timeout_seconds: 0, disable_ctrl_alt_del: false,
      grub: { enabled: false, password_hash: '' },
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

export const componentNames: Record<string, string> = { auditd: 'Linux Audit', native_fim: 'Agent 文件监控', tetragon: 'Tetragon', sudo: 'sudo 审计', ssh_auth: 'SSH 认证监控', task_wrapper: '任务执行记录', policies: '系统加固策略', ssh: 'SSH 策略', sysctl: '内核参数', grub: '启动保护' }

export function componentState(state: string): string {
  return ({ running: '运行中', ready: '就绪', applied: '已应用', configured: '已配置', disabled: '已禁用', installing: '安装中', pending: '等待应用', not_installed: '未安装', missing: '未安装', install_failed: '安装失败', config_failed: '配置失败', failed: '失败', error: '异常', drift: '配置偏离目标', audit: '仅检查', audit_only: '仅检查', unsupported: '环境不支持', degraded: '部分异常', stopped: '未运行', healthy: '正常' } as Record<string, string>)[state] || state || '未知状态'
}

export function componentTruncation(component: { omitted_checks?: number; checks?: unknown }): string {
  const notes: string[] = []
  if (typeof component.omitted_checks === 'number' && component.omitted_checks > 0) notes.push(`已省略 ${component.omitted_checks} 项检查`)
  if (Array.isArray(component.checks) && component.checks.some(check => check && typeof check === 'object' && check.truncated === true)) notes.push('部分检查长文本已截断')
  return notes.join('；')
}
