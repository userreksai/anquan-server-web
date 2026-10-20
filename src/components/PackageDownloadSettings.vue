<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Download, LoaderCircle, RefreshCw, ShieldCheck, ShieldOff, Timer } from 'lucide-vue-next'
import { api } from '../api'

interface DownloadSettings {
  enabled: boolean
  expires_at: string | null
  window_minutes: number
  allowed_hosts: string[]
  active_sessions: number
  active_connections: number
  bytes_transferred: number
  last_error?: string
}

const props = defineProps<{ refreshToken?: string }>()
const settings = ref<DownloadSettings | null>(null)
const windowMinutes = ref(15)
const hosts = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const message = ref('')
const now = ref(Date.now())
const controller = new AbortController()
let poll: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
const hostList = computed(() => [...new Set(hosts.value.split(/\s+/).filter(Boolean))])
const dirty = computed(() => settings.value !== null && (windowMinutes.value !== settings.value.window_minutes || hostList.value.join('\n') !== settings.value.allowed_hosts.join('\n')))
const enabled = computed(() => settings.value?.enabled === true && Boolean(settings.value.expires_at) && new Date(settings.value!.expires_at!).getTime() > now.value)
const remaining = computed(() => {
  if (!enabled.value || !settings.value?.expires_at) return ''
  const seconds = Math.max(0, Math.ceil((new Date(settings.value.expires_at).getTime() - now.value) / 1000))
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
})
const expiry = computed(() => settings.value?.expires_at ? new Date(settings.value.expires_at).toLocaleString('zh-CN', { hour12: false }) : '—')
const transferred = computed(() => {
  const bytes = settings.value?.bytes_transferred ?? 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
})

function parseSettings(value: DownloadSettings): DownloadSettings {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.allowed_hosts) || value.allowed_hosts.some(host => typeof host !== 'string') || !Number.isInteger(value.window_minutes) || value.window_minutes < 1 || value.window_minutes > 60 || (value.enabled && (typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)))) || [value.active_sessions, value.active_connections, value.bytes_transferred].some(count => !Number.isFinite(count) || count < 0)) throw new Error('下载管理响应无效，请刷新重试。')
  return value
}
function adopt(value: DownloadSettings, resetForm = false) {
  const keepDraft = dirty.value && !resetForm
  settings.value = parseSettings(value)
  if (!keepDraft) {
    hosts.value = value.allowed_hosts.join('\n')
    windowMinutes.value = value.window_minutes
  }
}
async function refresh() {
  if (loading.value || saving.value || controller.signal.aborted) return
  loading.value = true
  try {
    adopt(await api<DownloadSettings>('/settings/package-downloads', { signal: controller.signal }))
    error.value = ''
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取下载管理失败。'
  } finally { loading.value = false }
}
async function save(allow: boolean) {
  if (!settings.value || saving.value || controller.signal.aborted) return
  saving.value = true; error.value = ''; message.value = ''
  try {
    const current = settings.value
    const result = await api<DownloadSettings>('/settings/package-downloads', {
      method: 'PUT', signal: controller.signal,
      body: JSON.stringify({ enabled: allow, window_minutes: allow ? windowMinutes.value : current.window_minutes, allowed_hosts: allow ? hostList.value : current.allowed_hosts }),
    })
    if (controller.signal.aborted) return
    adopt(result, allow)
    now.value = Date.now()
    message.value = allow ? `已允许 Agent 在 ${windowMinutes.value} 分钟内按需下载。请重新下发需要安装组件的配置。` : '下载已关闭，现有下载连接已终止。'
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '更新下载管理失败。'
  } finally { saving.value = false }
}
onMounted(() => {
  void refresh()
  poll = setInterval(() => { if (!document.hidden) void refresh() }, 10000)
  clock = setInterval(() => { now.value = Date.now() }, 1000)
})
watch(() => props.refreshToken, () => { void refresh() })
onBeforeUnmount(() => { controller.abort(); clearInterval(poll); clearInterval(clock) })
</script>

<template>
  <section class="panel package-panel" aria-labelledby="package-download-heading" :aria-busy="saving">
    <header class="package-heading">
      <div><h2 id="package-download-heading"><Download :size="21" />Agent 安装包下载</h2><p>主控统一访问软件源，Agent 经内网下载组件及依赖。复用 TCP 55556，无需开放 55557。</p></div>
      <span class="badge" :class="enabled ? 'success' : 'neutral'"><span class="status-dot" />{{ enabled ? '限时允许下载' : '下载已关闭' }}</span>
    </header>
    <div class="package-notice"><ShieldCheck :size="20" /><p>默认关闭。允许下载后，Agent 仅在安装期间建立临时连接；安装完成即释放。授权到期或点击关闭，会终止下载连接；配置下发与心跳继续运行。</p></div>
    <div v-if="settings" class="package-stats">
      <div><span>活动安装会话</span><strong>{{ settings.active_sessions }}</strong></div>
      <div><span>当前下载连接</span><strong>{{ settings.active_connections }}</strong></div>
      <div><span>本次主控运行累计流量</span><strong>{{ transferred }}</strong></div>
      <div><span>授权剩余时间</span><strong class="package-countdown">{{ enabled ? remaining : '已关闭' }}</strong></div>
    </div>
    <p v-if="loading && !settings" class="package-loading" role="status"><LoaderCircle :size="17" class="spin" />正在读取下载设置…</p>
    <form v-if="settings" @submit.prevent="save(true)">
      <fieldset :disabled="saving">
        <div class="package-form">
          <div>
            <label for="package-window">本次允许下载时长</label>
            <select id="package-window" v-model="windowMinutes"><option v-if="![15, 30, 60].includes(windowMinutes)" :value="windowMinutes">{{ windowMinutes }} 分钟</option><option :value="15">15 分钟</option><option :value="30">30 分钟</option><option :value="60">60 分钟</option></select>
            <p class="package-hint"><Timer :size="15" />到期自动关闭。主控重启后保持关闭。</p>
            <p v-if="enabled" class="package-hint">当前截止：{{ expiry }}</p>
          </div>
          <div>
            <label for="package-hosts">允许的软件源域名</label>
            <textarea id="package-hosts" v-model="hosts" rows="11" spellcheck="false" autocomplete="off" aria-describedby="package-hosts-help" />
            <p id="package-hosts-help" class="package-hint">每行一个完整域名，Ubuntu EC2 区域镜像沿用内置通配规则。自定义镜像及下载重定向目标也需加入。仅允许公共地址的 80 / 443 端口。</p>
          </div>
        </div>
      </fieldset>
      <div class="package-actions">
        <button type="submit" class="button primary" :disabled="saving || loading || !hostList.length"><LoaderCircle v-if="saving" :size="17" class="spin" /><Download v-else :size="17" />{{ enabled ? `保存并延长 ${windowMinutes} 分钟` : `允许下载 ${windowMinutes} 分钟` }}</button>
        <button type="button" class="button secondary package-stop" :disabled="saving || !settings.enabled" @click="save(false)"><ShieldOff :size="17" />立即关闭下载</button>
        <button type="button" class="button secondary" :disabled="loading || saving" @click="refresh"><RefreshCw :size="16" :class="{ spin: loading }" />刷新状态</button>
      </div>
      <p v-if="dirty" class="package-hint">域名或时长有未保存的修改，点击“允许下载”或“保存并延长”后生效。</p>
    </form>
    <p v-if="settings?.last_error" class="package-last-error">最近下载错误：{{ settings.last_error }}</p>
    <p v-if="error" class="package-error" role="alert">{{ error }}<button v-if="!settings" type="button" class="text-button" :disabled="loading" @click="refresh">重试</button></p>
    <p v-if="message" class="package-success" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.package-panel { padding: 24px; border-top: 3px solid var(--blue); }
.package-heading { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
h2 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 17px; }
.package-heading p, .package-hint { color: #718198; font-size: 12px; line-height: 1.8; }
.package-heading p { margin: 8px 0 0; }
.package-heading .badge { white-space: nowrap; }
.package-notice { display: flex; align-items: flex-start; gap: 11px; color: #315889; background: #f1f6ff; border-radius: 8px; padding: 15px; margin: 20px 0; }
.package-notice svg { flex-shrink: 0; margin-top: 1px; }
.package-notice p { margin: 0; font-size: 13px; line-height: 1.8; }
.package-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0 24px; }
.package-stats > div { padding: 16px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.package-stats span { font-size: 12px; color: #718198; }
.package-stats strong { display: block; margin-top: 10px; font-size: 23px; overflow-wrap: anywhere; }
.package-stats .package-countdown { font-size: 18px; line-height: 29px; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.package-form { display: grid; grid-template-columns: minmax(200px, .65fr) minmax(0, 1.35fr); gap: 30px; }
.package-form label { margin-bottom: 10px; font-size: 13px; }
textarea { font: 12px/1.7 Consolas, monospace; min-height: 220px; }
.package-hint { display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; }
.package-hint svg { flex-shrink: 0; margin-top: 3px; }
.package-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.package-stop { color: #b42318; }
.package-loading { display: flex; align-items: center; gap: 8px; color: #718198; }
.package-error, .package-success, .package-last-error { padding: 13px 15px; border-radius: 8px; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; margin: 16px 0 0; }
.package-error, .package-last-error { color: #b42318; background: #fff0ed; }
.package-success { color: #14734d; background: #edf9f2; }
@media(max-width: 900px) { .package-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .package-form { grid-template-columns: 1fr; gap: 16px; } }
@media(max-width: 550px) { .package-panel { padding: 18px; } .package-heading { flex-direction: column; } .package-stats { gap: 8px; } .package-stats > div { padding: 12px; } }
</style>
