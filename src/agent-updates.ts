export interface AgentUpdateRelease {
  version: string
  goos: string
  goarch: string
  sha256: string
  size: number
  binary_sha256: string
  binary_size: number
  created_at: string
}

export type AgentUpdateStatus = 'idle' | 'pending' | 'downloading' | 'restarting' | 'applied' | 'failed' | 'rolled_back'

export interface AgentUpdateMachine {
  machine_ip: string
  host: string
  alias: string
  connected: boolean
  supported: boolean
  agent_version: string
  goos: string
  goarch: string
  job_id: string
  target_version: string
  status: AgentUpdateStatus
  error: string
  updated_at: string | null
  completed_at: string | null
}

export interface AgentUpdateSettings {
  source_dir: string
  release: AgentUpdateRelease | null
  source_error: string
  items: AgentUpdateMachine[]
}

const statuses: AgentUpdateStatus[] = ['idle', 'pending', 'downloading', 'restarting', 'applied', 'failed', 'rolled_back']
const sha256 = /^[a-f0-9]{64}$/

// Unknown development versions cannot be ordered safely for a remote upgrade.
export function compareAgentVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    if (!match) return null
    const parts = match.slice(1).map(Number)
    return parts.every(Number.isSafeInteger) ? parts : null
  }
  const a = parse(left), b = parse(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1
  }
  return 0
}

export function agentUpdateReason(item: AgentUpdateMachine, release: AgentUpdateRelease | null): string {
  if (!release) return '请先读取并打包新版本'
  if (!item.connected) return 'Agent 长连接未在线'
  if (!item.supported) return '需先手工部署支持更新的 0.7.3 或更高版本'
  if (['pending', 'downloading', 'restarting'].includes(item.status)) return '已有升级任务正在执行'
  if (item.goos !== release.goos || item.goarch !== release.goarch) return '操作系统或架构与更新包不匹配'
  const comparison = compareAgentVersions(release.version, item.agent_version)
  if (comparison === null) return '无法比较版本，请核对正式版本号'
  if (comparison <= 0) return '当前版本已相同或更高'
  return ''
}

export function reconcileAgentUpdateSelection(selected: string[], previousRelease: string | null, settings: AgentUpdateSettings): { ips: string[]; releaseChanged: boolean } {
  const releaseChanged = previousRelease !== (settings.release?.sha256 ?? null)
  if (releaseChanged) return { ips: [], releaseChanged }
  const eligible = new Set(settings.items.filter(item => !agentUpdateReason(item, settings.release)).map(item => item.machine_ip))
  return { ips: [...new Set(selected)].filter(ip => eligible.has(ip)), releaseChanged }
}

export function parseAgentUpdateSettings(value: unknown): AgentUpdateSettings {
  const invalid = () => { throw new Error('Agent 更新状态响应无效，请刷新重试。') }
  if (!value || typeof value !== 'object') return invalid()
  const data = value as AgentUpdateSettings
  if (typeof data.source_dir !== 'string' || (data.source_error !== undefined && data.source_error !== null && typeof data.source_error !== 'string') || !Array.isArray(data.items)) return invalid()
  if (data.release !== null) {
    const release = data.release
    if (!release || [release.version, release.goos, release.goarch].some(field => typeof field !== 'string' || !field) || !sha256.test(release.sha256) || !sha256.test(release.binary_sha256) || [release.size, release.binary_size].some(size => !Number.isSafeInteger(size) || size <= 0) || !Number.isFinite(Date.parse(release.created_at))) return invalid()
  }
  const seen = new Set<string>()
  for (const item of data.items) {
    if (!item || typeof item.machine_ip !== 'string' || !item.machine_ip || seen.has(item.machine_ip) || typeof item.connected !== 'boolean' || typeof item.supported !== 'boolean' || [item.host, item.alias, item.agent_version, item.goos, item.goarch, item.job_id, item.target_version, item.error].some(field => field !== undefined && field !== null && typeof field !== 'string') || !statuses.includes(item.status) || [item.updated_at, item.completed_at].some(field => field !== undefined && field !== null && field !== '' && (typeof field !== 'string' || !Number.isFinite(Date.parse(field))))) return invalid()
    seen.add(item.machine_ip)
  }
  return data
}

export const agentUpdateStatusLabel: Record<AgentUpdateStatus, string> = { idle: '未升级', pending: '等待接收', downloading: '下载中', restarting: '替换并重启中', applied: '已升级', failed: '升级失败', rolled_back: '已回滚' }
export const agentUpdateStatusClass: Record<AgentUpdateStatus, string> = { idle: 'neutral', pending: 'warning', downloading: 'warning', restarting: 'warning', applied: 'success', failed: 'offline', rolled_back: 'warning' }
