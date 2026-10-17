export interface EventPolicy {
  tetragon_ignored_kinds: string[]
  scan_summary_retention_hours: 12 | 24
  security_event_min_severity: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical'
}

export const securityEventSeverityOptions = [
  { value: 'debug', label: '全部（包含调试）' },
  { value: 'info', label: '信息及以上' },
  { value: 'notice', label: '提示及以上' },
  { value: 'warning', label: '警告及以上（仅异常，推荐）' },
  { value: 'error', label: '错误及以上' },
  { value: 'critical', label: '严重' },
] as const

export const tetragonKindOptions = [
  { value: 'process_exec', label: '进程执行' },
  { value: 'process_exit', label: '进程退出' },
  { value: 'process_kprobe', label: '内核函数探针' },
  { value: 'process_tracepoint', label: '内核跟踪点' },
  { value: 'process_loader', label: '进程加载' },
  { value: 'process_uprobe', label: '用户态探针' },
  { value: 'process_lsm', label: 'Linux 安全模块' },
  { value: 'process_usdt', label: '用户态静态跟踪' },
  { value: 'runtime', label: '其他运行事件' },
] as const

export function readEventPolicy(value: unknown): EventPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('事件策略响应无效，请重试。')
  const policy = value as Record<string, unknown>
  const kinds = policy.tetragon_ignored_kinds
  const severity = policy.security_event_min_severity === undefined ? 'warning' : policy.security_event_min_severity
  if (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string' || !tetragonKindOptions.some(option => option.value === kind)) || ![12, 24].includes(policy.scan_summary_retention_hours as number) || !securityEventSeverityOptions.some(option => option.value === severity)) {
    throw new Error('事件策略响应无效，请重试。')
  }
  return {
    tetragon_ignored_kinds: tetragonKindOptions.filter(option => kinds.includes(option.value)).map(option => option.value),
    scan_summary_retention_hours: policy.scan_summary_retention_hours as 12 | 24,
    security_event_min_severity: severity as EventPolicy['security_event_min_severity'],
  }
}
