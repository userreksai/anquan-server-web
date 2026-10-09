const moduleNames: Record<string, string> = {
  files: '文件检测',
  file: '文件检测',
  md5: '文件 MD5 检测',
  existence: '文件存在性检测',
  processes: '进程监控',
  process: '进程监控',
  login: '登录采集',
  history: '命令采集',
  state: '基线状态',
  machine: '机器状态',
}

function value(data: Record<string, unknown>, key: string): string {
  const field = data[key]
  return field === undefined || field === null ? '' : String(field)
}

export function moduleLabel(data: Record<string, unknown>): string {
  const module = value(data, 'module')
  return moduleNames[module] || module || '—'
}

export function alertKindLabel(data: Record<string, unknown>): string {
  const kind = value(data, 'kind')
  const module = value(data, 'module')
  const isProcess = ['processes', 'process'].includes(module)
  const isFile = ['files', 'file', 'md5', 'existence'].includes(module)
  const labels: Record<string, string> = {
    abnormal_offline: '机器异常离线',
    parse_error: '命令记录格式异常',
    collection_error: '采集异常',
    inspection_error: '文件检查失败',
    not_found: '未找到配置的目标文件',
    md5_mismatch: '文件 MD5 与允许值不匹配',
  }
  if (isFile || isProcess) Object.assign(labels, {
    missing: isProcess ? '必需进程未运行' : '配置的文件或目录不存在',
    missing_or_type_mismatch: '配置文件不存在或类型不匹配',
    added: isProcess ? '进程实例增加' : '新增监控文件',
    modified: isProcess ? '进程实例变化' : '监控文件内容已修改',
    deleted: isProcess ? '进程实例减少' : '监控文件已删除',
  })
  return labels[kind] || kind || '—'
}

export function alertTitle(data: Record<string, unknown>): string {
  const module = value(data, 'module')
  const kind = value(data, 'kind')
  const message = value(data, 'message')
  if (module === 'machine' && kind === 'abnormal_offline') return '机器异常离线'
  // Type fields remain reliable when agent/system error messages contain English details.
  if (kind === 'collection_error' || kind === 'inspection_error') return alertKindLabel(data)
  if (['processes', 'process'].includes(module)) {
    if (kind === 'missing') return '必需进程未运行'
    const before = value(data, 'before')
    const after = value(data, 'after')
    if (['added', 'modified', 'deleted'].includes(kind) && before && after) {
      return `运行实例数量由 ${before} 变为 ${after}`
    }
    if (['added', 'modified', 'deleted'].includes(kind)) return alertKindLabel(data)
  }
  if (['files', 'file', 'md5', 'existence'].includes(module)) {
    const label = alertKindLabel(data)
    if (label !== kind && label !== '—') return label
  }
  const messages: Record<string, string> = {
    'configured file or directory does not exist': '配置的文件或目录不存在',
    'configured file does not exist or has the wrong type': '配置文件不存在或类型不匹配',
    'monitored file deleted': '监控文件已删除',
    'monitored file modified': '监控文件内容已修改',
    'monitored file added': '新增监控文件',
    'md5 mismatch': '文件 MD5 与允许值不匹配',
    'current md5 does not match any configured allowed value': '文件 MD5 与允许值不匹配',
    'not_found': '未找到配置的目标文件',
    'no regular file with the configured exact filename was found': '未找到配置的目标文件',
    'process missing': '必需进程未运行',
    'none of the required command alternatives is running': '必需进程未运行',
    'file content or membership changed': '文件内容或监控范围发生变化',
  }
  const translated = messages[message.trim().toLowerCase()]
  if (translated) return translated
  const countChange = /^running instance count changed from (\d+) to (\d+)$/i.exec(message.trim())
  if (countChange) return `运行实例数量由 ${countChange[1]} 变为 ${countChange[2]}`
  if (kind === 'md5_mismatch' || kind === 'not_found') return alertKindLabel(data)
  return message || kind || '安全告警'
}
