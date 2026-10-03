export interface Machine {
  ip: string
  host: string
  source_ip: string
  reported_ip: string
  alias: string
  notes: string
  first_seen: string
  last_seen: string
  last_event_at: string
  last_summary: Record<string, unknown> | null
  interval_seconds: number
  event_count: number
  alert_count: number
  open_alert_count: number
  login_count: number
  online: boolean
  status: 'online' | 'abnormal_offline'
  offline_after_seconds: number
}

export interface SecurityEvent {
  id: number
  event_id: string
  machine_ip: string
  host: string
  type: string
  time: string
  received_at: string
  status: 'open' | 'resolved'
  notes: string
  data: Record<string, unknown>
}

export interface Overview {
  machines: number
  online_machines: number
  events: number
  alerts: number
  open_alerts: number
  ssh_logins: number
  pending_notifications: number
}

export interface Webhook {
  id: number
  name: string
  url: string
  format: 'feishu' | 'wecom' | 'generic'
  enabled: boolean
  created_at: string
  updated_at: string
  last_error: string
  last_success_at: string
  pending_count: number
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}
