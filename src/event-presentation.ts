import type { SecurityEvent } from './types'

export function eventStatusPresentation(event: Pick<SecurityEvent, 'type' | 'status' | 'data'>) {
  if (event.type === 'command_history') return { label: '已记录', tone: 'neutral', resolved: false }
  if (event.status === 'resolved') return { label: '已处理', tone: 'success', resolved: true }
  const needsAttention = event.type === 'alert' || event.type === 'security_event' && ['warning', 'error', 'critical'].includes(String(event.data.severity))
  const recorded = ['security_event', 'component_status'].includes(event.type) && !needsAttention
  return { label: recorded ? '已记录' : '待处理', tone: needsAttention ? 'warning' : 'neutral', resolved: false }
}
