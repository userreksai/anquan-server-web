export interface FileSnapshot {
  key: 'previous' | 'current'
  label: string
  status: string
  statusLabel: string
  note: string
  text: string | null
  sha256: string
  size: number | null
  truncated: boolean
}

const statusLabels: Record<string, string> = {
  captured: '已留存内容', empty: '空文件', truncated: '内容已截断', binary: '非文本文件',
  sensitive: '敏感内容不采集', disabled: '未启用内容留存', unavailable: '未捕获内容', not_applicable: '不适用',
}
const statusNotes: Record<string, string> = {
  captured: '已采集文本，删除原文件后仍可查看此记录。',
  empty: '采集时文件为空，已确认内容为零字节。',
  truncated: '仅保留内容前缀，未留存完整文件。',
  binary: '二进制或非 UTF-8 文件仅保留元数据。',
  sensitive: '敏感路径不保留文件内容。',
  disabled: '该版本未启用内容留存，没有文本快照。',
  unavailable: '未捕获该版本内容；文件可能已在采集前删除，或此前没有留存快照。',
  not_applicable: '这个阶段没有文件内容。',
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function fileSnapshots(data: Record<string, unknown>): FileSnapshot[] {
  if (data.source !== 'native_fim' || data.kind !== 'file_change') return []
  const details = object(data.details)
  return (['previous', 'current'] as const).map(key => {
    const meta = object(details[key === 'previous' ? 'before' : 'after'])
    const input = details[`${key}_text`]
    const suppliedStatus = details[`${key}_content_status`]
    const absent = (key === 'previous' && details.change === 'added') || (key === 'current' && ['deleted', 'missing'].includes(String(details.change)))
    let status = absent ? 'not_applicable' : typeof suppliedStatus === 'string' && Object.hasOwn(statusLabels, suppliedStatus) ? suppliedStatus :
      suppliedStatus === undefined && typeof input === 'string' ? input ? 'captured' : 'empty' : 'unavailable'
    let text: string | null = null
    if (['captured', 'empty', 'truncated'].includes(status)) {
      if (typeof input === 'string' && (status !== 'empty' || input === '')) text = input
      else if (status === 'empty' && meta.size === 0) text = ''
      else status = 'unavailable'
    }
    let truncated = status === 'truncated' || details[`${key}_text_truncated`] === true
    // Older events only carried text fields. Do not interpret absent fields as
    // an empty script, or render arbitrary JSON as file contents.
    if (text !== null && text.length > 65536) {
      text = text.slice(0, 65536).replace(/[\uD800-\uDBFF]$/, '')
      truncated = true
    }
    if (truncated && text !== null) status = 'truncated'
    let note = statusNotes[status]!
    if (absent) note = key === 'previous' ? '新增前文件不存在。' : '文件已删除；可查看变更前留存的内容。'
    else if (status === 'unavailable' && details.text_omitted_transport_limit === true) note = '旧版事件因传输大小限制未保留文本内容。'
    return {
      key, label: key === 'previous' ? details.change === 'deleted' ? '删除前留存内容' : '变更前内容' : '变更后内容',
      status, statusLabel: statusLabels[status]!, note, text,
      sha256: typeof meta.sha256 === 'string' && /^[a-f\d]{64}$/i.test(meta.sha256) ? meta.sha256 : '',
      size: typeof meta.size === 'number' && Number.isSafeInteger(meta.size) && meta.size >= 0 ? meta.size : null,
      truncated,
    }
  })
}
