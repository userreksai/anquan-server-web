export class ApiError extends Error {
  constructor(message: string, public status: number, public details: unknown = null) { super(message) }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch {
    throw new ApiError('无法连接主控服务，请检查网络或稍后重试。', 0)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('auth-expired'))
    throw new ApiError(body?.message || body?.error || `请求失败（${response.status}）`, response.status, body)
  }
  return body as T
}

export function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value))
  })
  return `?${params.toString()}`
}
