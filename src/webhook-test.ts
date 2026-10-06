import { api, ApiError } from './api'
import type { WebhookTestFeedback, WebhookTestResult } from './types'

const invalidResultMessage = '主控返回的测试结果格式不匹配，无法确认发送结果。请检查主控版本及反向代理是否正确转发 /api。'

function isTestResult(value: unknown): value is WebhookTestResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return typeof result.message === 'string' && result.message.trim().length > 0
    && typeof result.success === 'boolean'
    && typeof result.text === 'string' && result.text.trim().length > 0
    && ['feishu', 'wecom', 'generic'].includes(String(result.format))
    && typeof result.duration_ms === 'number' && Number.isFinite(result.duration_ms) && result.duration_ms >= 0
    && (result.http_status === undefined || typeof result.http_status === 'number' && Number.isInteger(result.http_status))
    && (result.business_code === undefined || typeof result.business_code === 'number' && Number.isInteger(result.business_code))
    && (!result.success || (
      typeof result.http_status === 'number' && result.http_status >= 200 && result.http_status < 300
      && (result.business_code === undefined ? result.format === 'generic' : result.business_code === 0)
    ))
}

export async function requestWebhookTest(path: string, name: string, body?: string): Promise<WebhookTestFeedback> {
  const feedback: WebhookTestFeedback = { name, checked_at: '', result: null, error: '' }
  try {
    const result = await api<unknown>(path, { method: 'POST', ...(body === undefined ? {} : { body }) })
    if (!isTestResult(result)) {
      feedback.error = invalidResultMessage
    } else {
      feedback.result = result
    }
  } catch (error) {
    if (error instanceof ApiError && isTestResult(error.details) && !error.details.success) {
      feedback.result = error.details
    } else if (error instanceof ApiError && error.details && typeof error.details === 'object' && 'success' in error.details) {
      feedback.error = invalidResultMessage
    } else {
      feedback.error = error instanceof Error ? error.message : '测试请求失败，请稍后重试。'
    }
  }
  feedback.checked_at = new Date().toISOString()
  return feedback
}
