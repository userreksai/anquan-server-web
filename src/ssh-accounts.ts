import { componentReportStale } from './security-profile'
import type { ComponentReport } from './types'

export interface SshAccount {
  name: string
  uid: number
  gid: number
  shell: string
  login_shell: boolean
}

export interface SshAccountSnapshot {
  usable: boolean
  users: SshAccount[]
  checkedAt: string
  total: number
  truncated: boolean
  message: string
}

export function sshAccountSnapshot(report: ComponentReport | undefined, machineIP: string, now = Date.now()): SshAccountSnapshot {
  const empty: SshAccountSnapshot = { usable: false, users: [], checkedAt: '', total: 0, truncated: false, message: '该机器尚未上报账户清单；请升级 Agent 并启用安全扩展，等待状态上报。' }
  if (!report || report.machine_ip !== machineIP || !report.data || typeof report.data !== 'object') return empty
  const inventory = report.data.inventory
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return empty
  const raw = (inventory as Record<string, unknown>).ssh_accounts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const value = raw as Record<string, unknown>
  if (value.state === 'unsupported') return { ...empty, message: '该 Agent 环境不支持读取 Linux 本机账户。' }
  if (value.state === 'error') return { ...empty, message: `Agent 读取账户失败：${typeof value.error === 'string' ? value.error : '请检查主机日志。'}` }
  if (value.state !== 'ready' || value.source !== '/etc/passwd' || !Array.isArray(value.users) || value.users.length > 256 || typeof value.checked_at !== 'string' || typeof value.truncated !== 'boolean' || typeof value.total !== 'number' || !Number.isInteger(value.total) || value.total < value.users.length || (!value.truncated && value.total !== value.users.length)) {
    return { ...empty, message: '账户清单格式无效，请升级 Agent 后重新读取。' }
  }
  const names = new Set<string>()
  const users: SshAccount[] = []
  for (const item of value.users) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ...empty, message: '账户清单包含无效记录，不能用于选择。' }
    const user = item as Record<string, unknown>
    if (typeof user.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(user.name) || user.name.length > 128 || names.has(user.name) || typeof user.uid !== 'number' || !Number.isInteger(user.uid) || user.uid < 0 || user.uid > 0xffffffff || typeof user.gid !== 'number' || !Number.isInteger(user.gid) || user.gid < 0 || user.gid > 0xffffffff || typeof user.shell !== 'string' || user.shell.length > 256 || /[\x00-\x1f\x7f]/.test(user.shell) || typeof user.login_shell !== 'boolean') return { ...empty, message: '账户清单包含无效记录，不能用于选择。' }
    names.add(user.name)
    users.push({ name: user.name, uid: user.uid, gid: user.gid, shell: user.shell, login_shell: user.login_shell })
  }
  const result = { ...empty, users, checkedAt: value.checked_at, total: value.total, truncated: value.truncated }
  const checked = Date.parse(value.checked_at)
  const received = Date.parse(report.received_at)
  if (!Number.isFinite(checked) || !Number.isFinite(received) || checked > now + 60_000 || received > now + 60_000) return { ...result, message: '账户清单时间无效或主机时钟偏差过大，不能用于选择。' }
  if (componentReportStale(report, now) || componentReportStale({ ...report, received_at: value.checked_at }, now)) return { ...result, message: '账户清单已过期，不能用于选择。请等待 Agent 上报新快照后重新读取。' }
  return { ...result, usable: true, message: value.truncated ? `账户列表已截断：显示 ${users.length} / ${value.total} 个账户；未显示不代表不存在。` : `已读取 ${value.total} 个本机账户；存在账户不代表已配置 SSH 密钥或允许登录。` }
}
